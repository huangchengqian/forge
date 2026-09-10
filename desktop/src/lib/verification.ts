/** User-facing names for the completion-verification levels.
 *
 * The API/storage name is `trustLevel` (`low | medium | high`) — a legacy
 * name that never surfaces in the UI. What it actually controls is how hard
 * "the model says it is done" is checked before a session is called
 * completed (see src/guardrails/should-stop-after-turn.ts):
 *
 *   low    → accept the stop (questions, discussion)
 *   medium → run the criteria, or the project's `npm test` when none are set
 *   high   → criteria + the deterministic evaluator
 */
import type { TrustLevel } from "../types.ts";

export const TRUST_LEVELS: ReadonlyArray<{
  value: TrustLevel;
  label: string;
  hint: string;
}> = [
  { value: "low", label: "不校验", hint: "模型说完成即完成 · 适合问答与讨论" },
  { value: "medium", label: "标准", hint: "有验收标准就逐条核对 · 否则跑项目测试" },
  { value: "high", label: "严格", hint: "验收标准核对 + 独立评估器复核" },
];

/** Display name for a level; falls back to the raw value if unknown. */
export function trustLabel(level: string | null | undefined): string {
  if (!level) return "未知";
  return TRUST_LEVELS.find((l) => l.value === level)?.label ?? level;
}
