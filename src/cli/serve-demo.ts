import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TMP = "/tmp/forge-serve-demo";
const PORT_A = 20000 + (process.pid % 20000);
const PORT_B = PORT_A + 1;
const GOAL = "Create hello.txt containing server-e2e-ok";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVE_SCRIPT = join(ROOT, "src/cli/serve.ts");

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORGE_HOME: TMP,
    FORGE_TASKS_DIR: join(TMP, "tasks"),
    FORGE_MEMORY_PATH: join(TMP, "memory.json"),
    FORGE_EVENTS_DIR: join(TMP, "events"),
    FORGE_RUNTIME: "fake",
    FORGE_FAKE_DELAY_MS: "4000",
    ANTHROPIC_API_KEY: "sk-dummy",
  };
}

function startServer(port: number): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx/esm", SERVE_SCRIPT, "--port", String(port)], {
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c: Buffer) => process.stdout.write(`  [server:${port}] ${c}`));
  child.stderr?.on("data", (c: Buffer) => process.stderr.write(`  [server:${port}!] ${c}`));
  return child;
}

type Handshake = { port: number; token: string };

async function waitReady(port: number, timeoutMs: number): Promise<Handshake> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(join(TMP, "server.json"), "utf8");
      const hs = JSON.parse(raw) as Handshake;
      if (hs.port === port && hs.token) {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) return hs;
      }
    } catch {}
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  throw new Error(`server on ${port} not ready within ${timeoutMs}ms`);
}

let currentToken = "";

async function api<T>(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const headers = { authorization: `Bearer ${currentToken}`, ...(init?.headers ?? {}) };
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
  const body = (await r.json()) as T;
  return { status: r.status, body };
}

async function waitForState(port: number, taskId: string, want: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await api<{ state?: string }>(port, `/tasks/${taskId}`);
    if (body.state && body.state === want) return body.state;
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  throw new Error(`task never reached ${want} within ${timeoutMs}ms`);
}

type SseItem = { seq: number; timestamp: number; type: string; payload: Record<string, unknown> };

async function collectStream(port: number, taskId: string, token: string, ms: number): Promise<SseItem[]> {
  const ac = new AbortController();
  const out: SseItem[] = [];
  const done = (async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/tasks/${taskId}/stream?token=${encodeURIComponent(token)}`, { signal: ac.signal });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              out.push(JSON.parse(line.slice(6)) as SseItem);
            } catch {}
          }
        }
      }
    } catch {}
  })();
  setTimeout(() => ac.abort(), ms);
  await done.catch(() => {});
  return out;
}

function describe(item: SseItem): string {
  const p = item.payload ?? {};
  if (item.type === "STATE_CHANGED") return `seq=${item.seq} STATE_CHANGED ${p.from}→${p.to}`;
  if (item.type === "STEP_STARTED") return `seq=${item.seq} STEP_STARTED ${p.stepId}`;
  if (item.type === "OBSERVATION_CREATED") return `seq=${item.seq} OBSERVATION_CREATED ${p.result}`;
  if (item.type === "TASK_COMPLETED") return `seq=${item.seq} TASK_COMPLETED`;
  if (item.type === "EVALUATION_COMPLETED") return `seq=${item.seq} EVALUATION_COMPLETED ${JSON.stringify(p.status ?? "")}`;
  return `seq=${item.seq} ${item.type}`;
}

async function main() {
  console.log("==== Phase 7.1 Long Running Server — Crash Recovery Demo ====\n");
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(TMP, "tasks"), { recursive: true });

  console.log("--- 1. start forge serve (A) ---");
  const a = startServer(PORT_A);
  children.push(a);
  const hsA = await waitReady(PORT_A, 15_000);
  currentToken = hsA.token;
  console.log("  server A ready (token acquired from handshake)");

  console.log("\n--- 2. create task ---");
  const created = await api<{ taskId: string; state: string }>(PORT_A, "/tasks", {
    method: "POST",
    body: JSON.stringify({ goal: GOAL, provider: "fake", modelId: "fake" }),
  });
  const taskId = created.body.taskId;
  console.log(`  taskId=${taskId} state=${created.body.state}`);

  console.log("\n--- 3. wait until EXECUTE (prompt in flight), then write the artifact ---");
  await waitForState(PORT_A, taskId, "EXECUTE", 10_000);
  const taskDir = join(TMP, "tasks", taskId);
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, "hello.txt"), "server-e2e-ok\n", "utf8");
  console.log("  wrote hello.txt while prompt was in flight");

  console.log("\n--- 4. SIGKILL server A (true crash, mid-EXECUTE) ---");
  a.kill("SIGKILL");
  await new Promise<void>((r) => a.once("exit", () => r()));
  console.log("  server A killed");

  console.log("\n--- 5. restart as forge serve (B) on a fresh port ---");
  const b = startServer(PORT_B);
  children.push(b);
  const hsB = await waitReady(PORT_B, 15_000);
  currentToken = hsB.token;
  console.log("  server B ready");

  console.log("\n--- 6. POST /tasks/:id/resume ---");
  const resumed = await api<{ resumed: boolean; message: string }>(PORT_B, `/tasks/${taskId}/resume`, { method: "POST" });
  console.log(`  ${resumed.status} ${JSON.stringify(resumed.body)}`);
  if (!resumed.body.resumed) throw new Error(`resume rejected: ${resumed.body.message}`);

  console.log("\n--- 7. wait for COMPLETE ---");
  await waitForState(PORT_B, taskId, "COMPLETE", 20_000);
  console.log("  task COMPLETE after resume");

  console.log("\n--- 8. Durable event stream (protocol v1): full replay incl. pre-crash history ---");
  const items = await collectStream(PORT_B, taskId, hsB.token, 4000);
  for (const it of items.slice(0, 40)) {
    console.log(`  ${describe(it)}`);
  }

  const finalBody = await api<{ state: string; lastEvaluation: { status: string } | null }>(PORT_B, `/tasks/${taskId}`);
  console.log(`\nfinal: state=${finalBody.body.state} evaluation=${finalBody.body.lastEvaluation?.status ?? "-"}`);

  const seqs = items.map((i) => i.seq);
  const monotonic = seqs.every((s, i) => i === 0 || s > seqs[i - 1]!);
  const types = items.map((i) => i.type);
  const ok =
    finalBody.body.state === "COMPLETE" &&
    types.includes("TASK_CREATED") &&
    types.includes("STEP_STARTED") &&
    types.includes("TASK_COMPLETED") &&
    monotonic;
  console.log(`\nevents received: ${items.length}, seq monotonic: ${monotonic}`);
  console.log(`RESULT: ${ok ? "PASS" : "FAIL"}`);

  if (!ok) process.exitCode = 1;
}

const children: ChildProcess[] = [];

function cleanup(): void {
  for (const c of children.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {}
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(cleanup, 100).unref?.();
    cleanup();
  });
