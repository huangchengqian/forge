export type SuccessCriterion =
  | { kind: "file_exists"; path: string }
  | { kind: "file_contains"; path: string; pattern: string }
  | { kind: "file_not_contains"; path: string; pattern: string }
  | { kind: "command_exit_zero"; command: string; cwd?: string }
  | { kind: "test_pass"; name: string }
  | { kind: "git_diff_contains"; pattern: string }
  | { kind: "directory_exists"; path: string };

export type CriterionResult = {
  criterion: SuccessCriterion;
  passed: boolean;
  message: string;
  exitCode: number | undefined;
  output: string | undefined;
  metadata: Record<string, unknown> | undefined;
};
