import type { ApprovalMode } from "../types.ts";

/** The three approval postures, in picker order. */
export const APPROVAL_MODES: ReadonlyArray<{ value: ApprovalMode; label: string; hint: string }> = [
  {
    value: "ask",
    label: "每次询问",
    hint: "每条命令都弹窗等你批准",
  },
  {
    value: "default",
    label: "默认",
    hint: "白名单内的安全命令（ls / cat / git status…）直接放行，其余询问",
  },
  {
    value: "always",
    label: "始终允许",
    hint: "不再弹窗；破坏性命令仍被拒绝并终止会话",
  },
];

export function approvalLabel(mode: ApprovalMode): string {
  return APPROVAL_MODES.find((m) => m.value === mode)?.label ?? mode;
}
