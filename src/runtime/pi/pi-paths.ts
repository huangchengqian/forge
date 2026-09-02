import { resolve } from "node:path";

export const PI_REPO_DIR = resolve(
  process.env.PI_REPO_DIR ?? "/Users/hcq/forge/pi",
);

export const PI_RPC_ENTRY = resolve(
  PI_REPO_DIR,
  "packages/coding-agent/dist/rpc-entry.js",
);

export function requirePiEntry(): string {
  return PI_RPC_ENTRY;
}
