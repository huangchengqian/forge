import type { Skill } from "./types.ts";

export const FILE_CREATION_SKILL: Skill = {
  id: "file_creation",
  name: "File Creation",
  description: "Create a single file with verification",
  version: "1.0.0",
  category: "workflow",
  steps: [
    {
      id: "step-create",
      intent: "create the target file with specified content",
      status: "pending",
      attempts: 0,
      successCriteria: [
        { kind: "file_exists", path: "{{path}}" },
        { kind: "file_contains", path: "{{path}}", pattern: "{{pattern}}" },
      ],
      dependencies: [],
      executionGroup: undefined,
    },
  ],
  defaultCriteria: [
    { kind: "file_exists", path: "{{path}}" },
  ],
  metadata: {
    keywords: ["create", "file", "write", "new", "generate"],
    domainHints: ["single-file-creation", "content-verification"],
    executionHints: ["use write tool", "verify with file_exists + file_contains"],
  },
};

export const TYPESCRIPT_PROJECT_SKILL: Skill = {
  id: "typescript_project",
  name: "TypeScript Project",
  description: "Create or modify a TypeScript file with type-check verification",
  version: "1.0.0",
  category: "language",
  steps: [
    {
      id: "step-create-ts",
      intent: "create the TypeScript file with required exports",
      status: "pending",
      attempts: 0,
      successCriteria: [
        { kind: "file_exists", path: "{{path}}" },
        { kind: "file_contains", path: "{{path}}", pattern: "export " },
      ],
      dependencies: [],
      executionGroup: undefined,
    },
    {
      id: "step-typecheck",
      intent: "run tsc to verify the TypeScript file compiles",
      status: "pending",
      attempts: 0,
      successCriteria: [
        { kind: "command_exit_zero", command: "npx -y -p typescript@5 tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext {{path}}" },
      ],
      dependencies: ["step-create-ts"],
      executionGroup: undefined,
    },
  ],
  defaultCriteria: [
    { kind: "file_exists", path: "{{path}}" },
    { kind: "command_exit_zero", command: "npx -y -p typescript@5 tsc --noEmit {{path}}" },
  ],
  metadata: {
    keywords: ["typescript", "ts", "type", "compile", "tsc", "typecheck", "function", "utility"],
    domainHints: ["node-typescript", "strict-mode"],
    executionHints: ["ensure export keyword present", "use isolatedModules"],
  },
};

export const BUG_FIX_SKILL: Skill = {
  id: "bug_fix",
  name: "Bug Fix",
  description: "Analyze failure, modify code, run test to verify",
  version: "1.0.0",
  category: "workflow",
  steps: [
    {
      id: "step-analyze",
      intent: "analyze the error output and identify the root cause",
      status: "pending",
      attempts: 0,
      successCriteria: [],
      dependencies: [],
      executionGroup: undefined,
    },
    {
      id: "step-modify",
      intent: "modify the source file to address the root cause",
      status: "pending",
      attempts: 0,
      successCriteria: [
        { kind: "file_contains", path: "{{path}}", pattern: "{{expectedPattern}}" },
        { kind: "file_not_contains", path: "{{path}}", pattern: "{{buggyPattern}}" },
      ],
      dependencies: ["step-analyze"],
      executionGroup: undefined,
    },
    {
      id: "step-verify",
      intent: "run the test or command to verify the fix",
      status: "pending",
      attempts: 0,
      successCriteria: [
        { kind: "command_exit_zero", command: "{{verifyCommand}}" },
      ],
      dependencies: ["step-modify"],
      executionGroup: undefined,
    },
  ],
  defaultCriteria: [
    { kind: "command_exit_zero", command: "{{verifyCommand}}" },
  ],
  metadata: {
    keywords: ["fix", "bug", "error", "fail", "broken", "regression", "patch"],
    domainHints: ["incremental-fix", "test-after-each-change"],
    executionHints: ["read error before editing", "minimal-change"],
  },
};
