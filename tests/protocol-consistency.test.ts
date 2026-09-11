/**
 * Cross-boundary contract tests live here, not in src/: both package
 * tsconfigs pin rootDir to their own source tree, so a test that imports
 * across the boundary cannot live in either (TS6059). tsx runs it directly.
 *
 * The desktop mirrors the server's protocol list across a real package
 * boundary (desktop ↔ server). Mirroring is fine; silent drift is not —
 * this test is the contract that keeps the two lists identical.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_APIS } from "../src/server/config-store.ts";
import { PROVIDER_PROTOCOLS } from "../desktop/src/lib/protocols.ts";

describe("protocol list consistency (desktop ↔ server)", () => {
  test("the desktop's protocol list matches the server's, order included", () => {
    assert.deepEqual([...PROVIDER_PROTOCOLS], [...PROVIDER_APIS]);
  });
});
