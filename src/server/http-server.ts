import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { EventBus } from "../events/index.ts";
import { readEvents } from "../core/persistence/event-log.ts";
import type { ForgeEvent } from "../events/index.ts";
import { CreateTaskError, TaskManager, type ServerRuntimeKind } from "./task-manager.ts";
import { RuntimeSupervisor } from "./runtime-supervisor.ts";
import { isAuthorized, newToken, removeHandshake, writeHandshake, type Handshake } from "./auth.ts";
import { EVENT_PROTOCOL_VERSION, TaskEventStream } from "./event-stream.ts";
import { ProjectsRegistry } from "./projects.ts";
import { ApprovalHub } from "./approval-hub.ts";
import { computeDiff, restoreUndo } from "./undo.ts";
import { addMemory, listMemory, deleteMemory, retrieve, extractKeywords } from "../memory/index.ts";
import { loadForgeConfig, saveForgeConfig, validateProvider, type ForgeConfig, type ProviderConfig } from "./config-store.ts";
import { checkProvider } from "./provider-check.ts";
import { checkRuntime } from "./runtime-readiness.ts";
import { PiRuntime } from "../runtime/pi/index.ts";
import { syncCustomModels, piAgentDir } from "./pi-models.ts";

export type ForgeServerOptions = {
  port: number;
  host: string;
  forgeHome: string;
  runtimeKind: ServerRuntimeKind;
  defaultProvider: string;
  defaultModelId: string;
  maxConcurrency: number | undefined;
};

export type ForgeServerHandle = {
  url: string;
  port: number;
  token: string;
  manager: TaskManager;
  projects: ProjectsRegistry;
  close: () => Promise<void>;
};

export async function startForgeServer(opts: ForgeServerOptions): Promise<ForgeServerHandle> {
  const bus = new EventBus();
  const supervisor = new RuntimeSupervisor((m) => console.log(`[supervisor] ${m}`));
  const projects = new ProjectsRegistry(opts.forgeHome);
  const approvalHub = new ApprovalHub();
  const manager = new TaskManager({
    bus,
    forgeHome: opts.forgeHome,
    runtimeKind: opts.runtimeKind,
    defaultProvider: opts.defaultProvider,
    defaultModelId: opts.defaultModelId,
    maxConcurrency: opts.maxConcurrency,
    supervisor,
    projects,
    approvalHub,
  });
  const token = newToken();

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, manager, bus, projects, token, opts.forgeHome).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: String(err) }));
    });
  });

  await new Promise<void>((resolveP, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolveP();
    });
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;

  const handshake: Handshake = {
    protocolVersion: EVENT_PROTOCOL_VERSION,
    port,
    host: opts.host,
    token,
    pid: process.pid,
    startedAt: Date.now(),
  };
  await writeHandshake(opts.forgeHome, handshake);

  return {
    url: `http://${opts.host}:${port}`,
    port,
    token,
    manager,
    projects,
    close: async () => {
      await removeHandshake(opts.forgeHome);
      bus.publish({ type: "failed", taskId: "__server__", reason: "server shutting down", at: Date.now() });
      await new Promise<void>((resolveP) => server.close(() => resolveP()));
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  manager: TaskManager,
  bus: EventBus,
  projects: ProjectsRegistry,
  token: string,
  forgeHome: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  res.setHeader("x-forge-protocol", String(EVENT_PROTOCOL_VERSION));
  // Loopback-only server, bearer-token protected; permissive CORS keeps
  // browser-based dev (vite) working. Unauthorized requests still get 401.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, protocolVersion: EVENT_PROTOCOL_VERSION });
    return;
  }

  if (!isAuthorized(req, url, token)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/tasks/preflight") {
    const body = await readBody(req);
    const preflightInput: { projectId?: string; provider?: string; modelId?: string; providerId?: string } = {};
    if (typeof body.projectId === "string") preflightInput.projectId = body.projectId;
    if (typeof body.provider === "string") preflightInput.provider = body.provider;
    if (typeof body.modelId === "string") preflightInput.modelId = body.modelId;
    if (typeof body.providerId === "string") preflightInput.providerId = body.providerId;
    const result = await manager.preflight(preflightInput);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/tasks") {
    const body = await readBody(req);
    const goal = typeof body.goal === "string" ? body.goal.trim() : "";
    if (!goal) {
      json(res, 400, { error: "goal is required" });
      return;
    }
    const createInput: { goal: string; provider?: string; modelId?: string; providerId?: string; maxConcurrency?: number; projectId?: string } = { goal };
    if (typeof body.provider === "string") createInput.provider = body.provider;
    if (typeof body.modelId === "string") createInput.modelId = body.modelId;
    if (typeof body.providerId === "string") createInput.providerId = body.providerId;
    if (typeof body.maxConcurrency === "number") createInput.maxConcurrency = body.maxConcurrency;
    if (typeof body.projectId === "string") createInput.projectId = body.projectId;
    try {
      const { taskId } = await manager.create(createInput);
      const task = await manager.get(taskId);
      json(res, 202, { taskId, state: task?.state ?? "READY" });
    } catch (err) {
      if (err instanceof CreateTaskError) {
        json(res, err.status, { error: err.message });
        return;
      }
      throw err;
    }
    return;
  }

  if (req.method === "GET" && parts[0] === "tasks" && parts.length === 1) {
    json(res, 200, { tasks: await manager.list() });
    return;
  }

  if (req.method === "GET" && parts[0] === "tasks" && parts.length === 2) {
    const task = await manager.get(parts[1]!);
    if (!task) {
      json(res, 404, { error: "no such task" });
      return;
    }
    json(res, 200, task);
    return;
  }

  if (req.method === "GET" && parts[0] === "tasks" && parts[2] === "stream") {
    const task = await manager.get(parts[1]!);
    if (!task) {
      json(res, 404, { error: "no such task" });
      return;
    }
    await streamDurableEvents(req, res, forgeHome, parts[1]!);
    return;
  }

  if (req.method === "GET" && parts[0] === "tasks" && parts[2] === "events") {
    await streamEvents(req, res, parts[1]!, manager, bus);
    return;
  }

  if (req.method === "POST" && parts[0] === "tasks" && parts[2] === "cancel") {
    const result = await manager.cancel(parts[1]!);
    json(res, result.cancelled ? 202 : 409, result);
    return;
  }

  if (req.method === "POST" && parts[0] === "tasks" && parts[2] === "resume") {
    const result = await manager.resume(parts[1]!);
    json(res, result.resumed ? 202 : 409, result);
    return;
  }

  if (req.method === "POST" && parts[0] === "tasks" && parts[2] === "message" && parts.length === 3) {
    const body = await readBody(req);
    const text = typeof body.message === "string" ? body.message : "";
    const result = await manager.message(parts[1]!, text);
    json(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === "POST" && parts[0] === "tasks" && parts[2] === "subscription" && parts.length === 3) {
    const body = await readBody(req);
    const providerId = typeof body.providerId === "string" ? body.providerId : "";
    if (!providerId) {
      json(res, 400, { error: "providerId is required" });
      return;
    }
    const result = await manager.switchModel(parts[1]!, providerId);
    json(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === "POST" && parts[0] === "tasks" && parts[2] === "rename" && parts.length === 3) {
    const body = await readBody(req);
    const goal = typeof body.goal === "string" ? body.goal.trim() : "";
    if (!goal) {
      json(res, 400, { error: "goal is required" });
      return;
    }
    const result = await manager.rename(parts[1]!, goal);
    json(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === "DELETE" && parts[0] === "tasks" && parts.length === 2) {
    const result = await manager.deleteTask(parts[1]!);
    json(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === "GET" && parts[0] === "tasks" && parts[2] === "approvals" && parts.length === 3) {
    const task = await manager.get(parts[1]!);
    if (!task) {
      json(res, 404, { error: "no such task" });
      return;
    }
    json(res, 200, { approvals: manager.listApprovals(parts[1]!) });
    return;
  }

  if (req.method === "POST" && parts[0] === "tasks" && parts[2] === "approvals" && (parts[4] === "approve" || parts[4] === "deny")) {
    const task = await manager.get(parts[1]!);
    if (!task) {
      json(res, 404, { error: "no such task" });
      return;
    }
    const body = await readBody(req);
    const always = body.always === true;
    const result = parts[4] === "approve"
      ? await manager.approve(parts[1]!, parts[3]!, always)
      : await manager.deny(parts[1]!, parts[3]!);
    json(res, result.ok ? 200 : 404, result);
    return;
  }

  if (req.method === "GET" && parts[0] === "tasks" && parts[2] === "diff" && parts.length === 3) {
    const task = await manager.get(parts[1]!);
    if (!task) {
      json(res, 404, { error: "no such task" });
      return;
    }
    const workspace = task.workspacePath ?? task.directory;
    if (!workspace) {
      json(res, 400, { error: "task has no workspace" });
      return;
    }
    const diff = await computeDiff(forgeHome, parts[1]!, workspace);
    json(res, 200, diff);
    return;
  }

  if (req.method === "POST" && parts[0] === "tasks" && parts[2] === "undo" && parts.length === 3) {
    const task = await manager.get(parts[1]!);
    if (!task) {
      json(res, 404, { error: "no such task" });
      return;
    }
    if (manager.isActive(parts[1]!)) {
      json(res, 409, { ok: false, message: "task is still running; undo after it settles" });
      return;
    }
    const result = await restoreUndo(forgeHome, parts[1]!);
    json(res, 200, { ok: true, ...result });
    return;
  }

  if (req.method === "POST" && parts[0] === "projects" && parts.length === 1) {
    const body = await readBody(req);
    const p = typeof body.path === "string" ? body.path : "";
    const name: string | undefined = typeof body.name === "string" ? body.name : undefined;
    try {
      const project = await projects.register(name !== undefined ? { path: p, name } : { path: p });
      json(res, 201, project);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.method === "GET" && parts[0] === "projects" && parts.length === 1) {
    json(res, 200, await projects.list());
    return;
  }

  if (req.method === "POST" && parts[0] === "projects" && parts.length === 3 && parts[2] === "select") {
    try {
      json(res, 200, await projects.select(parts[1]!));
    } catch (err) {
      json(res, 404, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.method === "GET" && parts[0] === "projects" && parts.length === 2 && parts[1] === "active") {
    json(res, 200, { project: await projects.active() });
    return;
  }

  if (req.method === "GET" && parts[0] === "memory" && parts.length === 1) {
    const typeFilter = url.searchParams.get("type");
    let items = await listMemory();
    if (typeFilter) items = items.filter((i) => i.type === typeFilter);
    json(res, 200, { items });
    return;
  }

  if (req.method === "GET" && parts[0] === "memory" && parts[1] === "search") {
    const q = url.searchParams.get("q") ?? "";
    const typesParam = url.searchParams.get("types");
    const types = typesParam ? (typesParam.split(",").filter(Boolean) as never[]) : undefined;
    const results = await retrieve({
      query: q,
      types,
      maxResults: Number(url.searchParams.get("max") ?? 10),
      minConfidence: Number(url.searchParams.get("min") ?? 0.5),
    });
    json(res, 200, { results });
    return;
  }

  if (req.method === "DELETE" && parts[0] === "memory" && parts.length === 2) {
    const ok = await deleteMemory(parts[1]!);
    json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "no such memory" });
    return;
  }

  if (req.method === "POST" && parts[0] === "memory" && parts.length === 1) {
    const body = await readBody(req);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) {
      json(res, 400, { error: "content is required" });
      return;
    }
    const item = await addMemory({
      type: (typeof body.type === "string" && body.type) as Parameters<typeof addMemory>[0]["type"],
      content,
      source: (typeof body.source === "string" && body.source ? body.source : "USER") as never,
      confidence: typeof body.confidence === "number" ? body.confidence : 1,
      keywords: Array.isArray(body.keywords)
        ? (body.keywords as string[])
        : [...extractKeywords(content)],
      taskRefs: Array.isArray(body.taskRefs) ? (body.taskRefs as string[]) : [],
    });
    json(res, 201, item);
    return;
  }

  if (req.method === "GET" && url.pathname === "/config") {
    json(res, 200, await loadForgeConfig(forgeHome));
    return;
  }

  if (req.method === "PUT" && url.pathname === "/config") {
    const body = await readBody(req);
    const current = await loadForgeConfig(forgeHome);
    // Full-config save: `providers[]` + `defaultProviderId` + maxConcurrency.
    let providers: ProviderConfig[];
    if (Array.isArray(body.providers)) {
      const validated = (body.providers as unknown[])
        .map((p) => validateProvider(p))
        .filter((p): p is ProviderConfig => p !== null);
      if (validated.length !== (body.providers as unknown[]).length) {
        json(res, 400, { error: "invalid provider config: each entry needs api, apiKey, modelId, baseUrl" });
        return;
      }
      providers = validated;
    } else {
      providers = current.providers;
    }
    const defaultProviderId =
      typeof body.defaultProviderId === "string"
        ? body.defaultProviderId
        : current.defaultProviderId;
    const next: ForgeConfig = {
      version: 2,
      providers,
      defaultProviderId: providers.some((p) => p.id === defaultProviderId)
        ? defaultProviderId
        : (providers[0]?.id ?? null),
      maxConcurrency: typeof body.maxConcurrency === "number" ? body.maxConcurrency : current.maxConcurrency,
    };
    await saveForgeConfig(forgeHome, next);
    json(res, 200, next);
    return;
  }

  if (req.method === "POST" && url.pathname === "/config/test") {
    const body = await readBody(req);
    const provider = validateProvider(body);
    if (!provider) {
      json(res, 400, { error: "invalid provider config" });
      return;
    }

    const providerResult = await checkProvider(provider);

    if (providerResult.status === "FAIL") {
      json(res, 422, {
        provider: providerResult,
        runtime: null,
        status: "FAIL",
        message: "provider unreachable; skipping runtime check",
      });
      return;
    }

    // Runtime check uses the custom path: declare the provider in Forge's
    // models.json (apiKey lives there) and spawn Pi with the subscription id
    // as its provider name.
    await syncCustomModels(forgeHome, [provider]);
    const rt = new PiRuntime(forgeHome, { piAgentDir: piAgentDir(forgeHome) });
    const runtimeResult = await checkRuntime(rt, {
      forgeHome,
      provider: provider.id,
      modelId: provider.modelId,
    });

    const overall = runtimeResult.status === "FAIL" ? "FAIL" : "PASS";
    json(res, overall === "PASS" ? 200 : 422, {
      provider: providerResult,
      runtime: runtimeResult,
      status: overall,
    });
    return;
  }

  json(res, 404, { error: "not found" });
}

async function streamDurableEvents(
  req: IncomingMessage,
  res: ServerResponse,
  forgeHome: string,
  taskId: string,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });

  const send = (env: unknown) => {
    res.write(`data: ${JSON.stringify(env)}\n\n`);
  };

  const stream = new TaskEventStream(join(forgeHome, "events"), taskId);
  req.on("close", () => stream.stop());
  await stream.follow(send);
}

async function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  manager: TaskManager,
  bus: EventBus,
): Promise<void> {
  const task = await manager.get(taskId);
  if (!task) {
    json(res, 404, { error: "no such task" });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const buffered: ForgeEvent[] = [];
  let liveOpen = false;
  const unsubscribe = bus.subscribe((event) => {
    if (event.taskId !== taskId) return;
    if (liveOpen) {
      send({ kind: "live", event });
    } else {
      buffered.push(event);
    }
  });

  try {
    const history = await readEvents(taskId);
    for (const h of history) {
      send({ kind: "history", event: h });
    }
  } catch {}
  send({ kind: "history_end" });
  for (const e of buffered.splice(0)) {
    send({ kind: "live", event: e });
  }
  liveOpen = true;

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveP) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString("utf8")));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(data || "{}");
        resolveP(typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolveP({});
      }
    });
  });
}
