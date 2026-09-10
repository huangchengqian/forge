import { startForgeServer } from "../server/http-server.ts";
import { listSessions, saveSession } from "../core/persistence/session-store.ts";
import { resolve } from "node:path";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const forgeHome = resolve(process.env.FORGE_HOME ?? join(process.env.HOME ?? "/tmp", ".forge"));
const port = Number(arg("--port") ?? 5300);
const host = arg("--host") ?? "127.0.0.1";

import { join } from "node:path";

/** A session can only be `running` while the process running it is alive. We
 * are that process and we have just booted, so any `running` session on disk is
 * an orphan from a crash or a hard quit. Leaving it as `running` makes the UI
 * render a Steer box against a session nothing is driving — input is accepted
 * and silently dropped. Mark it failed so it shows as resumable instead. */
async function reconcileOrphanedRuns(): Promise<void> {
  const orphans = (await listSessions()).filter((s) => s.status === "running");
  for (const session of orphans) {
    session.status = "failed";
    session.failureReason = "interrupted: the Forge server restarted while this session was running";
    session.updatedAt = Date.now();
    await saveSession(session);
  }
  if (orphans.length > 0) {
    console.log(`[forge] reconciled ${orphans.length} orphaned running session(s) -> failed`);
  }
}

await reconcileOrphanedRuns();

const handle = await startForgeServer({ port, host, forgeHome });
console.log(`[forge] serving on ${handle.url} (forge home: ${forgeHome})`);

const shutdown = async () => {
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
