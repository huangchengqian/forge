/** User-facing names for reasoning effort (Pi's thinking levels).
 *
 * The API/storage name is `thinkingLevel`, a direct pass-through to Pi — this
 * module only supplies the words. What it controls is how much reasoning the
 * model is asked to spend before it answers.
 *
 * `"off"` is not the absence of a value: it means no reasoning parameter is
 * sent at all, which is also what a non-reasoning model does. It is shown as
 * a real choice so the control never lies about what will happen.
 *
 * Only the levels a given model advertises (server-side
 * `getSupportedThinkingLevels`) are ever offered — see ModelPicker.
 */
import type { ThinkingLevel } from "../types.ts";

export const THINKING_LEVELS: ReadonlyArray<{
  value: ThinkingLevel;
  label: string;
  hint: string;
}> = [
  { value: "off", label: "关", hint: "不请求推理 · 最快，也最省" },
  { value: "minimal", label: "极低", hint: "最少的推理开销" },
  { value: "low", label: "低", hint: "轻量推理 · 适合小改动" },
  { value: "medium", label: "中", hint: "默认 · 速度与质量平衡" },
  { value: "high", label: "高", hint: "深入推理 · 适合复杂任务" },
  { value: "xhigh", label: "极高", hint: "仅部分模型支持" },
  { value: "max", label: "最大", hint: "仅部分模型支持" },
];

/** Display name for a level; falls back to the raw value if unknown. */
export function thinkingLabel(level: string | null | undefined): string {
  if (!level) return "默认";
  return THINKING_LEVELS.find((l) => l.value === level)?.label ?? level;
}

/** Label + hint for a level, tolerating values this build does not know. */
export function thinkingMeta(level: string): { label: string; hint: string } {
  const found = THINKING_LEVELS.find((l) => l.value === level);
  return found ? { label: found.label, hint: found.hint } : { label: level, hint: "" };
}
