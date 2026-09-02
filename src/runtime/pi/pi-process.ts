import { type ChildProcess, spawn } from "node:child_process";
import { requirePiEntry } from "./pi-paths.ts";

export type PiProcess = {
  pid: number;
  child: ChildProcess;
  kill: (signal?: NodeJS.Signals) => void;
};

export type SpawnOptions = {
  directory: string;
  provider: string;
  modelId: string;
  env: Record<string, string> | undefined;
  /** Absolute paths of Pi extensions to load via --extension (e.g. forge-guard). */
  extensions?: readonly string[];
};

export async function spawnPi(opts: SpawnOptions): Promise<PiProcess> {
  const entry = requirePiEntry();

  const args = [
    entry,
    "--mode",
    "rpc",
    "--provider",
    opts.provider,
    "--model",
    opts.modelId,
  ];
  for (const ext of opts.extensions ?? []) {
    args.push("--extension", ext);
  }

  const child = spawn(process.execPath, args, {
    cwd: opts.directory,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!child.pid) {
    throw new Error("forge: failed to spawn Pi (no pid)");
  }

  const proc: PiProcess = {
    pid: child.pid,
    child,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      if (!child.killed && child.exitCode === null) {
        child.kill(signal);
      }
    },
  };

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[pi stderr] ${chunk.toString("utf8")}`);
  });

  await new Promise<void>((resolveP, reject) => {
    const timer = setTimeout(() => reject(new Error("forge: Pi spawn timeout (5s)")), 5_000);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("spawn", () => {
      clearTimeout(timer);
      resolveP();
    });
    if (child.pid !== undefined && child.exitCode === null) {
      clearTimeout(timer);
      resolveP();
    }
  });

  return proc;
}
