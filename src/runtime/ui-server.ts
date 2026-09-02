import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { loadTask } from "../core/persistence/task-store.ts";
import { listMemory } from "../memory/store.ts";
import type { EventBus } from "../events/index.ts";
import type { ForgeEvent } from "../events/index.ts";
import type { TaskSession } from "../core/types/task-session.ts";
import type { MemoryItem } from "../memory/index.ts";


export type UiSnapshot = {
  task: TaskSession | null;
  memory: readonly MemoryItem[];
};

export type UiServerOptions = {
  taskId: string;
  bus: EventBus;
  port: number;
  host: string;
};

export type UiServerHandle = {
  url: string;
  port: number;
  close: () => Promise<void>;
};

export async function startUiServer(opts: UiServerOptions): Promise<UiServerHandle> {
  const sseClients = new Set<ServerResponse>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!req.url) {
        res.writeHead(400).end("no url");
        return;
      }
      const url = new URL(req.url, `http://${opts.host}`);
      if (url.pathname === "/snapshot") {
        const snap = await snapshot(opts.taskId);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(snap));
        return;
      }
      if (url.pathname === "/events") {
        sseClients.add(res);
        sseResponse(res);
        try {
          const initial = await snapshot(opts.taskId);
          sseWrite(res, { kind: "snapshot", payload: initial });
        } catch (err) {
          sseWrite(res, { kind: "event", payload: { type: "failed", taskId: opts.taskId, reason: String(err), at: Date.now() } });
        }
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" }).end(String(err));
    }
  });

  const unsubscribe = opts.bus.subscribe((event: ForgeEvent) => {
    const payload = JSON.stringify({ kind: "event", payload: event });
    for (const client of sseClients) {
      try {
        client.write(`data: ${payload}\n\n`);
      } catch {}
    }
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
  const url = `http://${opts.host}:${port}`;

  return {
    url,
    port,
    close: async () => {
      unsubscribe();
      for (const c of sseClients) {
        try {
          c.end();
        } catch {}
      }
      sseClients.clear();
      await new Promise<void>((resolveP) => server.close(() => resolveP()));
    },
  };
}

async function snapshot(taskId: string): Promise<UiSnapshot> {
  const task = await loadTask(taskId);
  const memory = await listMemory();
  return { task, memory };
}

function sseResponse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  res.write(": hello\n\n");
}

function sseWrite(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
