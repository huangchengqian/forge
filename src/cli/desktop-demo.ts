import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";

const TMP = "/tmp/forge-desktop-demo";
const GOAL = "Create a TypeScript utility: write src/calc.ts exporting add(a,b)=a+b, and test/calc.test.ts that asserts add(1,2)==3. Run the test via 'npx -y -p typescript@5 tsc --noEmit' to type-check and then run 'node --test' to execute the assertion.";

const ENV = {
  ...process.env,
  FORGE_HOME: TMP,
  FORGE_TASKS_DIR: join(TMP, "tasks"),
  FORGE_EVENTS_DIR: join(TMP, "events"),
  FORGE_MEMORY_PATH: join(TMP, "memory.json"),
  FORGE_RUNTIME: "pi",
};

const PI_TIMEOUT_MS = 180_000;

type Headers = Record<string, string>;

function findHandshake(dir: string, timeoutMs: number): Promise<{ port: number; token: string }> {
  const path = join(dir, "server.json");
  return new Promise((resolveP, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const raw = await readFile(path, "utf8");
        const hs = JSON.parse(raw) as { port: number; token: string };
        if (hs.port && hs.token) return resolveP(hs);
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error("handshake timeout"));
      setTimeout(tick, 200);
    };
    void tick();
  });
}

function getJson<T>(port: number, path: string, headers: Headers): Promise<T> {
  return new Promise((resolveP, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => (buf += c.toString("utf8")));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 400) return reject(new Error(`GET ${path} → ${res.statusCode}: ${buf}`));
          try {
            resolveP(JSON.parse(buf) as T);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

type Envelope = { seq: number; timestamp: number; type: string; payload: Record<string, unknown> };

function streamEvents(port: number, taskId: string, token: string, ms: number): Promise<Envelope[]> {
  const ac = new AbortController();
  return new Promise((resolveP) => {
    const out: Envelope[] = [];
    const timer = setTimeout(() => {
      ac.abort();
      resolveP(out);
    }, ms);
    void (async () => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: `/tasks/${taskId}/stream?token=${encodeURIComponent(token)}`,
          method: "GET",
          headers: { accept: "text/event-stream" },
          signal: ac.signal,
        },
        (res) => {
          if (!res.statusCode || res.statusCode >= 400) return;
          let buf = "";
          res.on("data", (c: Buffer) => {
            buf += c.toString("utf8");
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const line of frame.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                try {
                  out.push(JSON.parse(line.slice(6)) as Envelope);
                } catch {}
              }
            }
          });
          res.on("end", () => {
            clearTimeout(timer);
            resolveP(out);
          });
        },
      );
      req.on("error", () => {});
      req.end();
    })();
  });
}

async function main(): Promise<void> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  const serveScript = resolve("src/cli/serve.ts");
  console.log(`[1] spawning forge serve (real Pi) at ${serveScript}`);
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx/esm", serveScript, "--port", "0"], {
    env: ENV,
    stdio: ["ignore", "inherit", "inherit"],
  });

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      child.kill("SIGTERM");
      await new Promise<void>((r) => setTimeout(r, 300));
      if (!child.killed) child.kill("SIGKILL");
    } catch {}
  };
  process.on("SIGINT", () => { void cleanup().then(() => process.exit(0)); });
  process.on("SIGTERM", () => { void cleanup().then(() => process.exit(0)); });

  const { port, token } = await findHandshake(TMP, 15_000);
  console.log(`[2] handshake: port=${port} token=${token.slice(0, 8)}...`);
  const headers: Headers = { authorization: `Bearer ${token}` };

  const goal = GOAL;
  console.log(`[3] POST /tasks  goal="${goal.slice(0, 60)}..."`);
  const createBody = JSON.stringify({ goal, provider: "glm-anthropic", modelId: "glm-4-flash" });
  const taskId = await new Promise<string>((resolveP, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/tasks", method: "POST", headers: { ...headers, "content-type": "application/json" } },
      (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => (buf += c.toString("utf8")));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 400) return reject(new Error(`POST /tasks → ${res.statusCode}: ${buf}`));
          try {
            const parsed = JSON.parse(buf) as { taskId: string };
            resolveP(parsed.taskId);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(createBody);
    req.end();
  });
  console.log(`    taskId=${taskId}`);

  const streamP = streamEvents(port, taskId, token, PI_TIMEOUT_MS);
  const finalTask = await new Promise<{ state: string }>((resolveP, reject) => {
    const tick = setInterval(async () => {
      try {
        const t = await getJson<{ state: string }>(port, `/tasks/${taskId}`, headers);
        if (t.state === "COMPLETE" || t.state === "FAILED" || t.state === "REVIEW_REQUIRED") {
          clearInterval(tick);
          resolveP(t);
        }
      } catch (e) {
        clearInterval(tick);
        reject(e);
      }
    }, 2_000);
    setTimeout(() => {
      clearInterval(tick);
      reject(new Error("task terminal timeout"));
    }, PI_TIMEOUT_MS + 30_000);
  });

  const envelopes = await streamP;
  const finalDetails = await getJson<{ state: string; observations: unknown[]; fixCount: number; plan: { steps: unknown[] } | null }>(
    port,
    `/tasks/${taskId}`,
    headers,
  );
  const finalState = await finalTask;

  console.log(`\n[4] final: state=${finalState.state} fix=${finalDetails.fixCount} observations=${finalDetails.observations?.length ?? 0}`);

  console.log(`\n[5] Event Protocol v1 timeline (${envelopes.length} envelopes):`);
  for (const e of envelopes.slice(0, 60)) {
    const p = e.payload;
    let extra = "";
    if (e.type === "STATE_CHANGED" && typeof p.from === "string") {
      extra = ` ${p.from}→${p.to}`;
    } else if (e.type === "STEP_STARTED" && typeof p.stepId === "string") {
      extra = ` stepId=${p.stepId}`;
    } else if (e.type === "OBSERVATION_CREATED" && typeof p.result === "string") {
      extra = ` result=${p.result}`;
    } else if (e.type === "TASK_COMPLETED" || e.type === "TASK_FAILED") {
      extra = "";
    } else if (e.type === "EVALUATION_COMPLETED" && typeof p.status === "string") {
      extra = ` status=${p.status}`;
    }
    console.log(`    #${String(e.seq).padStart(2, " ")} ${e.type}${extra}`);
  }

  console.log(`\n[6] final plan:`);
  if (finalDetails.plan) {
    for (const s of finalDetails.plan.steps as Array<{ id: string; status: string; attempts: number }>) {
      console.log(`    ${s.id} status=${s.status} attempts=${s.attempts}`);
    }
  } else {
    console.log("    (no plan)");
  }

  console.log(`\n[7] observations:`);
  for (const o of finalDetails.observations as Array<{ result: string; stepId: string; attempt: number; failureReason?: string }>) {
    console.log(`    ${o.result} step=${o.stepId} attempt=${o.attempt}${o.failureReason ? " reason=" + o.failureReason : ""}`);
  }

  await cleanup();
  process.exit(finalState.state === "COMPLETE" ? 0 : 1);
}

void main();
