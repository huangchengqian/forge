import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const BENCH_ROOT = resolve(process.env.FORGE_BENCH_DIR ?? "/tmp/forge-benchmark");

process.env.FORGE_HOME = join(BENCH_ROOT, "home");
process.env.FORGE_TASKS_DIR = join(BENCH_ROOT, "tasks");
process.env.FORGE_EVENTS_DIR = join(BENCH_ROOT, "events");
process.env.FORGE_MEMORY_PATH = join(BENCH_ROOT, "memory.json");

export async function prepareBenchRoot(): Promise<string> {
  await rm(BENCH_ROOT, { recursive: true, force: true }).catch(() => {});
  await mkdir(join(BENCH_ROOT, "workspaces"), { recursive: true });
  return BENCH_ROOT;
}

export function benchRoot(): string {
  return BENCH_ROOT;
}
