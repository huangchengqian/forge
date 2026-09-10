import { createServer, type IncomingMessage, type Server } from "node:http";
import { EVENT_PROTOCOL_VERSION, TaskEventStream } from "./event-stream.ts";
import { eventsDir } from "../core/persistence/event-log.ts";
import { ApprovalHub } from "./approval-hub.ts";
import { ProjectsRegistry } from "./projects.ts";
import { SessionManager } from "./session-manager.ts";
import { computeDiff, restoreUndo } from "./undo.ts";
import { isAuthorized, newToken, writeHandshake } from "./auth.ts";
import { loadForgeConfig, saveForgeConfig } from "./config-store.ts";

export type ForgeServerOptions = {
  port: number;
  host?: string;
  forgeHome: string;
};

export type ForgeServerHandle = {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
};

export async function startForgeServer(opts: ForgeServerOptions): Promise<ForgeServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const projects = new ProjectsRegistry(opts.forgeHome);
  const approvalHub = new ApprovalHub();
  const manager = new SessionManager({ forgeHome: opts.forgeHome, projects, approvalHub });
  const token = newToken();

  const server: Server = createServer(async (req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (!isAuthorized(req, url, token)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    try {
      // --- Sessions ---
      if (req.method === "POST" && url.pathname === "/sessions") {
        const body = await readBody(req);
        const result = await manager.create({
          goal: typeof body.goal === "string" ? body.goal : "",
          ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}),
          ...(typeof body.providerId === "string" ? { providerId: body.providerId } : {}),
          ...(body.trustLevel ? { trustLevel: body.trustLevel } : {}),
          ...(Array.isArray(body.criteria) ? { criteria: body.criteria } : {}),
          ...(typeof body.maxCost === "number" ? { maxCost: body.maxCost } : {}),
          ...(typeof body.maxTurns === "number" ? { maxTurns: body.maxTurns } : {}),
        });
        json(res, 202, result);
        return;
      }

      if (req.method === "GET" && parts[0] === "sessions" && parts.length === 1) {
        json(res, 200, { sessions: await manager.list() });
        return;
      }

      if (req.method === "GET" && parts[0] === "sessions" && parts.length === 2) {
        const session = await manager.get(parts[1]!);
        if (!session) {
          json(res, 404, { error: "not found" });
          return;
        }
        json(res, 200, session);
        return;
      }

      if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ protocol: EVENT_PROTOCOL_VERSION })}\n\n`);
        const tail = new TaskEventStream(eventsDir(), parts[1]!);
        req.on("close", () => tail.stop());
        await tail.follow((env) => {
          res.write(`data: ${JSON.stringify(env)}\n\n`);
        });
        return;
      }

      if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "steer") {
        const body = await readBody(req);
        const result = await manager.steer(
          parts[1]!,
          typeof body.message === "string" ? body.message : "",
        );
        json(res, result.ok ? 200 : 409, result);
        return;
      }

      // Mid-session model switch. Running: effective at the next turn
      // boundary; idle: persisted for the next resume.
      if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "model") {
        const body = await readBody(req);
        if (typeof body.providerId !== "string" || !body.providerId) {
          json(res, 400, { error: "providerId is required" });
          return;
        }
        try {
          const result = await manager.switchModel(parts[1]!, body.providerId);
          json(res, 200, result);
        } catch (err) {
          json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // Mid-session completion-verification switch. Running: the guardrail
      // reads the new level at the next turn boundary; idle: persisted for the
      // next resume.
      if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "trust") {
        const body = await readBody(req);
        const level = body.trustLevel;
        if (level !== "low" && level !== "medium" && level !== "high") {
          json(res, 400, { error: 'trustLevel must be "low", "medium" or "high"' });
          return;
        }
        try {
          const result = await manager.switchTrust(parts[1]!, level);
          json(res, 200, result);
        } catch (err) {
          json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "abort") {
        const result = await manager.abort(parts[1]!);
        json(res, result.ok ? 202 : 409, result);
        return;
      }

      // POST /sessions/:id/resume — recover a failed/cancelled session.
      // Optional body: { message?: string } → injected as a user turn +
      // steering queue entry. Errors:
      //   404 = session not found
      //   409 = session status not in {failed, cancelled} OR already active
      //   500 = replay or subscription lookup failed
      if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "resume") {
        const body = await readBody(req);
        try {
          const result = await manager.resume(
            parts[1]!,
            typeof body.message === "string" ? { message: body.message } : {},
          );
          json(res, 202, result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(msg)) json(res, 404, { error: msg });
          else if (/cannot be resumed|already running/i.test(msg)) json(res, 409, { error: msg });
          else json(res, 500, { error: msg });
        }
        return;
      }

      if (req.method === "DELETE" && parts[0] === "sessions" && parts.length === 2) {
        const result = await manager.delete(parts[1]!);
        json(res, result.ok ? 200 : 409, result);
        return;
      }

      // --- Approvals ---
      if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "approvals") {
        json(res, 200, { approvals: manager.listApprovals(parts[1]!) });
        return;
      }

      if (
        req.method === "POST" &&
        parts[0] === "sessions" &&
        parts[2] === "approvals" &&
        (parts[4] === "approve" || parts[4] === "deny")
      ) {
        const result =
          parts[4] === "approve"
            ? await manager.approve(parts[1]!, parts[3]!)
            : await manager.deny(parts[1]!, parts[3]!);
        json(res, result.ok ? 200 : 404, result);
        return;
      }

      // --- Diff + Undo ---
      if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "diff") {
        const session = await manager.get(parts[1]!);
        if (!session) {
          json(res, 404, { error: "not found" });
          return;
        }
        json(res, 200, await computeDiff(opts.forgeHome, parts[1]!, session.workspace));
        return;
      }

      if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "undo") {
        json(res, 200, { ok: true, ...(await restoreUndo(opts.forgeHome, parts[1]!)) });
        return;
      }

      // --- Config (model subscriptions; Desktop Settings) ---
      if (req.method === "GET" && url.pathname === "/config") {
        json(res, 200, await loadForgeConfig(opts.forgeHome));
        return;
      }

      if (req.method === "PUT" && url.pathname === "/config") {
        const body = await readBody(req);
        await saveForgeConfig(opts.forgeHome, body as unknown as Parameters<typeof saveForgeConfig>[1]);
        json(res, 200, await loadForgeConfig(opts.forgeHome));
        return;
      }

      // --- Projects ---
      if (req.method === "POST" && url.pathname === "/projects") {
        const body = await readBody(req);
        const project = await projects.register({
          path: typeof body.path === "string" ? body.path : "",
          ...(typeof body.name === "string" ? { name: body.name } : {}),
        });
        json(res, 201, project);
        return;
      }

      if (req.method === "GET" && url.pathname === "/projects") {
        json(res, 200, await projects.list());
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolveP) => server.listen(opts.port, host, resolveP));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  const url = `http://${host}:${port}`;
  await writeHandshake(opts.forgeHome, {
    protocolVersion: 1,
    port,
    host,
    token,
    pid: process.pid,
    startedAt: Date.now(),
  });

  return {
    url,
    port,
    token,
    close: async () => {
      server.close();
    },
  };
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolveP) => {
    let buf = "";
    req.on("data", (c: Buffer) => (buf += c.toString("utf8")));
    req.on("end", () => {
      try {
        resolveP(JSON.parse(buf) as Record<string, any>);
      } catch {
        resolveP({});
      }
    });
    req.on("error", () => resolveP({}));
  });
}
