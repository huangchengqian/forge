/**
 * Protocol list — the desktop's single copy.
 *
 * The server has its own list (`PROVIDER_APIS` in src/server/config-store.ts):
 * that is a real boundary (two packages), so the mirror is intentional rather
 * than shared. What is NOT acceptable is silent drift — a protocol added on
 * one side and forgotten on the other. `src/server/protocol-consistency.test.ts`
 * asserts the two lists stay identical; that test is the contract.
 *
 * This module is deliberately React-free so the server-side test can import it.
 */
export const PROVIDER_PROTOCOLS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
] as const;

export type ProviderApi = (typeof PROVIDER_PROTOCOLS)[number];
