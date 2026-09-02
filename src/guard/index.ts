export * from "./policy.ts";
export * from "./extension.ts";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the guard extension entry, for `pi --extension <path>`.
 * Prefers the compiled dist output; falls back to the TS source (dev via tsx).
 */
export const GUARD_ENTRY_PATH: string = (() => {
  const src = fileURLToPath(new URL("./extension.ts", import.meta.url));
  const dist = src.replace(/src\/guard\/extension\.ts$/, "dist/guard/extension.js");
  return existsSync(dist) ? dist : src;
})();
