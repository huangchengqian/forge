#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startForgeServer } from "../server/index.ts";
import type { ServerRuntimeKind } from "../server/index.ts";

function parseArgs(argv: readonly string[]): { port: number; runtimeKind: ServerRuntimeKind } {
  const envKind = process.env.FORGE_RUNTIME === "fake" ? "fake" : process.env.FORGE_RUNTIME === "pi" ? "pi" : undefined;
  let port = 5300;
  let runtimeKind: ServerRuntimeKind = envKind ?? "pi";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--port") {
      const v = argv[i + 1];
      i++;
      if (v) port = Number(v);
    } else if (a === "--runtime") {
      const v = argv[i + 1];
      i++;
      if (v === "fake" || v === "pi") runtimeKind = v;
    }
  }
  return { port, runtimeKind };
}

async function main(): Promise<void> {
  const { port, runtimeKind } = parseArgs(process.argv.slice(2));
  const forgeHome = process.env.FORGE_HOME ?? `${process.env.HOME ?? "/tmp"}/.forge`;
  // Ensure the handshake file's directory exists — without this, a fresh
  // FORGE_HOME (e.g. first launch on a new machine) crashes serve with
  // ENOENT and the desktop shows "Load failed".
  await mkdir(forgeHome, { recursive: true });
  const defaultProvider = process.env.FORGE_PROVIDER ?? "anthropic";
  const defaultModelId = process.env.FORGE_MODEL ?? "claude-opus-4-8";

  const server = await startForgeServer({
    port,
    host: "127.0.0.1",
    forgeHome,
    runtimeKind,
    defaultProvider,
    defaultModelId,
    maxConcurrency: process.env.FORGE_MAX_CONCURRENCY ? Number(process.env.FORGE_MAX_CONCURRENCY) : undefined,
  });

  console.log(`forge serve ready at ${server.url}`);
  console.log(`  runtime: ${runtimeKind}`);
  console.log(`  forgeHome: ${resolve(forgeHome)}`);
  console.log(`  POST ${server.url}/tasks  {"goal":"...", "provider":"...", "modelId":"..."}`);

  const shutdown = async () => {
    console.log("\nforge serve shutting down");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("forge serve:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
