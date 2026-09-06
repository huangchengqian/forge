import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Plan } from "../src/core/types/plan.ts";
import type { PlanStep } from "../src/core/types/step.ts";
import type { Observation } from "../src/core/types/step.ts";
import { SAMPLE_PROJECT, type FixtureFile } from "./fixture.ts";
import { ScriptedRuntime, writeWorkspaceFile } from "./scripted-runtime.ts";
import type { Planner, TaskContext, CreatePlanResult, UpdatePlanResult } from "../src/orchestrator/planner.ts";
import type { GoldenTask } from "./types.ts";

class StaticPlanner implements Planner {
  constructor(private readonly steps: readonly PlanStep[]) {}

  async createPlan(_ctx: TaskContext): Promise<CreatePlanResult> {
    const now = Date.now();
    const plan: Plan = {
      id: randomUUID(),
      version: 1,
      objective: _ctx.task.goal,
      steps: this.steps.map((s) => ({ ...s, status: "pending", attempts: 0 })),
      createdAt: now,
      updatedAt: now,
    };
    return { plan, source: "llm", appliedSkills: [] };
  }

  async updatePlan(_ctx: TaskContext, _observation: Observation): Promise<UpdatePlanResult> {
    return null;
  }
}

/** Adds one necessary follow-up after the initial step verifies. */
class AdaptivePlanner extends StaticPlanner {
  private revised = false;

  override async updatePlan(ctx: TaskContext, observation: Observation): Promise<UpdatePlanResult> {
    if (this.revised || observation.result !== "PASS" || !ctx.task.plan) return null;
    this.revised = true;
    const followUp: PlanStep = {
      id: "step-follow-up",
      intent: "record the verified implementation in a completion marker",
      status: "pending",
      attempts: 0,
      dependencies: ctx.task.plan.steps.map((step) => step.id),
      executionGroup: undefined,
      successCriteria: [{ kind: "file_contains", path: "completion.txt", pattern: "verified" }],
    };
    return {
      changed: true,
      plan: {
        ...ctx.task.plan,
        version: ctx.task.plan.version + 1,
        steps: [...ctx.task.plan.steps, followUp],
        updatedAt: Date.now(),
      },
    };
  }
}

const CALC_PATH = "src/calc.ts";

async function readCalc(workspace: string): Promise<string> {
  return readFile(join(workspace, CALC_PATH), "utf8");
}

export const GOLDEN_TASKS: readonly GoldenTask[] = [
  {
    id: "A-add-divide",
    category: "new-feature",
    title: "Add a divide function to src/calc.ts",
    goal: "Add a divide function to src/calc.ts that returns a divided by b",
    buildPlanner: () =>
      new StaticPlanner([
        {
          id: "step-1",
          intent: "append a divide function to src/calc.ts",
          status: "pending",
          attempts: 0,
          dependencies: [],
          executionGroup: undefined,
          successCriteria: [
            { kind: "file_contains", path: CALC_PATH, pattern: "export function divide" },
            { kind: "file_contains", path: CALC_PATH, pattern: "a / b" },
          ],
        },
      ]),
    perform: async (_stepId, workspace) => {
      const src = await readCalc(workspace);
      if (!src.includes("export function divide")) {
        await writeWorkspaceFile(
          workspace,
          CALC_PATH,
          src +
            "\nexport function divide(a: number, b: number): number {\n  return a / b;\n}\n",
        );
      }
    },
  },
  {
    id: "B-fix-add",
    category: "bug-fix",
    title: "Fix add(): must return a + b, currently returns a - b",
    goal: "Fix the bug in src/calc.ts so that add returns a plus b instead of a minus b",
    buildPlanner: () =>
      new StaticPlanner([
        {
          id: "step-1",
          intent: "repair the add implementation in src/calc.ts",
          status: "pending",
          attempts: 0,
          dependencies: [],
          executionGroup: undefined,
          successCriteria: [
            { kind: "file_contains", path: CALC_PATH, pattern: "return a + b;" },
            { kind: "file_not_contains", path: CALC_PATH, pattern: "return a - b;" },
          ],
        },
      ]),
    perform: async (_stepId, workspace, attempt) => {
      const src = await readCalc(workspace);
      if (attempt < 2) {
        await writeWorkspaceFile(workspace, join("attempts", `attempt-${attempt}.txt`), "investigating");
        return;
      }
      await writeWorkspaceFile(workspace, CALC_PATH, src.replace("return a - b;", "return a + b;"));
    },
  },
  {
    id: "C-rename-sum",
    category: "refactor",
    title: "Rename add() to sum() across the project",
    goal: "Rename the exported add function in src/calc.ts to sum",
    buildPlanner: () =>
      new StaticPlanner([
        {
          id: "step-1",
          intent: "rename add to sum inside src/calc.ts",
          status: "pending",
          attempts: 0,
          dependencies: [],
          executionGroup: undefined,
          successCriteria: [
            { kind: "file_contains", path: CALC_PATH, pattern: "export function sum" },
            { kind: "file_not_contains", path: CALC_PATH, pattern: "export function add" },
          ],
        },
      ]),
    perform: async (_stepId, workspace) => {
      const src = await readCalc(workspace);
      if (!src.includes("export function sum")) {
        await writeWorkspaceFile(workspace, CALC_PATH, src.split("add").join("sum"));
      }
    },
  },
  {
    id: "D-add-tests",
    category: "test-addition",
    title: "Create test/calc.test.ts importing add from src/calc",
    goal: "Create a test file test/calc.test.ts that imports the add function and asserts 1 + 2 equals 3",
    buildPlanner: () =>
      new StaticPlanner([
        {
          id: "step-1",
          intent: "create test/calc.test.ts importing add from ../src/calc",
          status: "pending",
          attempts: 0,
          dependencies: [],
          executionGroup: undefined,
          successCriteria: [
            { kind: "file_exists", path: "test/calc.test.ts" },
            { kind: "file_contains", path: "test/calc.test.ts", pattern: "add" },
            { kind: "file_contains", path: "test/calc.test.ts", pattern: "assert" },
          ],
        },
      ]),
    perform: async (_stepId, workspace) => {
      await writeWorkspaceFile(
        workspace,
        join("test", "calc.test.ts"),
        'import assert from "node:assert/strict";\nimport { add } from "../src/calc";\n\nassert.equal(add(1, 2), 3);\n',
      );
    },
  },
  {
    id: "E-bump-version",
    category: "config-change",
    title: "Bump package.json version to 2.0.0 and add a test script",
    goal: "Update package.json: set version to 2.0.0 and add a test script running node --test",
    buildPlanner: () =>
      new StaticPlanner([
        {
          id: "step-version",
          intent: "set package.json version to 2.0.0",
          status: "pending",
          attempts: 0,
          dependencies: [],
          executionGroup: undefined,
          successCriteria: [
            { kind: "file_contains", path: "package.json", pattern: '"version": "2.0.0"' },
          ],
        },
        {
          id: "step-script",
          intent: "add a test script to package.json",
          status: "pending",
          attempts: 0,
          dependencies: ["step-version"],
          executionGroup: undefined,
          successCriteria: [
            { kind: "file_contains", path: "package.json", pattern: '"test"' },
          ],
        },
      ]),
    perform: async (stepId, workspace) => {
      const raw = await readFile(join(workspace, "package.json"), "utf8");
      if (stepId === "step-version") {
        const updated = raw.replace('"version": "1.0.0"', '"version": "2.0.0"');
        await writeFile(join(workspace, "package.json"), updated, "utf8");
        return;
      }
      if (stepId === "step-script") {
        const obj = JSON.parse(raw) as { scripts?: Record<string, string> };
        obj.scripts = { ...(obj.scripts ?? {}), test: "node --test" };
        await writeFile(join(workspace, "package.json"), JSON.stringify(obj, null, 2) + "\n", "utf8");
      }
    },
  },
  {
    id: "F-adaptive-follow-up",
    category: "adaptive-planning",
    title: "Revise the plan after verification and execute its new follow-up",
    goal: "Create the initial artifact, then record that it was verified",
    buildPlanner: () => new AdaptivePlanner([
      {
        id: "step-initial",
        intent: "create the initial artifact",
        status: "pending",
        attempts: 0,
        dependencies: [],
        executionGroup: undefined,
        successCriteria: [{ kind: "file_contains", path: "initial.txt", pattern: "ready" }],
      },
    ]),
    perform: async (stepId, workspace) => {
      if (stepId === "step-initial") {
        await writeWorkspaceFile(workspace, "initial.txt", "ready\n");
      } else if (stepId === "step-follow-up") {
        await writeWorkspaceFile(workspace, "completion.txt", "verified\n");
      }
    },
  },
  {
    id: "G-verify-command",
    category: "new-feature",
    title: "Create src/notes.md verified through a read-only command",
    goal: "Create src/notes.md with three bullet lines about HTTP status codes",
    buildPlanner: () =>
      new StaticPlanner([
        {
          id: "step-1",
          intent: "create src/notes.md with three bullet lines about HTTP status codes",
          status: "pending",
          attempts: 0,
          dependencies: [],
          executionGroup: undefined,
          // Exercises the read-only command allowance added to the
          // verification policy: `cat` runs as the verification command.
          successCriteria: [
            { kind: "file_contains", path: "src/notes.md", pattern: "- 404" },
            { kind: "command_exit_zero", command: "cat src/notes.md" },
          ],
        },
      ]),
    perform: async (_stepId, workspace) => {
      await writeWorkspaceFile(
        workspace,
        join("src", "notes.md"),
        "# HTTP status codes\n\n- 200 OK\n- 301 Moved Permanently\n- 404 Not Found\n- 500 Server Error\n",
      );
    },
  },
  {
    id: "H-dependent-steps",
    category: "new-feature",
    title: "Create greet module then an entry importing it",
    goal: "Create src/greet.ts exporting greet(), then create src/entry.ts importing it",
    buildPlanner: () =>
      new StaticPlanner([
        {
          id: "step-greet",
          intent: "create src/greet.ts exporting greet(name)",
          status: "pending",
          attempts: 0,
          dependencies: [],
          executionGroup: undefined,
          successCriteria: [
            { kind: "file_contains", path: "src/greet.ts", pattern: "export function greet" },
          ],
        },
        {
          id: "step-entry",
          intent: "create src/entry.ts importing greet from src/greet.ts",
          status: "pending",
          attempts: 0,
          dependencies: ["step-greet"],
          executionGroup: undefined,
          successCriteria: [
            { kind: "file_contains", path: "src/entry.ts", pattern: "greet" },
          ],
        },
      ]),
    perform: async (stepId, workspace) => {
      if (stepId === "step-greet") {
        await writeWorkspaceFile(
          workspace,
          join("src", "greet.ts"),
          'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n',
        );
      }
      if (stepId === "step-entry") {
        await writeWorkspaceFile(
          workspace,
          join("src", "entry.ts"),
          'import { greet } from "./greet";\n\nconsole.log(greet("forge"));\n',
        );
      }
    },
  },
  {
    id: "I-remove-stale-after-investigation",
    category: "refactor",
    title: "Remove the deprecated flag from config.json (investigates first)",
    goal: "Remove the deprecated \"legacyMode\" flag from config.json",
    buildPlanner: () =>
      new StaticPlanner([
        {
          id: "step-1",
          intent: "remove the legacyMode key from config.json",
          status: "pending",
          attempts: 0,
          dependencies: [],
          executionGroup: undefined,
          successCriteria: [
            { kind: "file_contains", path: "config.json", pattern: '"mode": "fast"' },
            { kind: "file_not_contains", path: "config.json", pattern: "legacyMode" },
          ],
        },
      ]),
    perform: async (_stepId, workspace, attempt) => {
      const raw = await readFile(join(workspace, "config.json"), "utf8");
      if (attempt < 1) {
        // First round: legitimately inspects, changes nothing.
        return;
      }
      const updated = raw
        .replace(/,\s*"legacyMode":\s*true/, "")
        .replace(/"legacyMode":\s*true,\s*/, "");
      await writeFile(join(workspace, "config.json"), updated, "utf8");
    },
  },
  {
    id: "J-directory-artifact",
    category: "new-feature",
    title: "Create assets directory with a manifest file",
    goal: "Create the assets directory containing manifest.json listing icon.svg",
    buildPlanner: () =>
      new StaticPlanner([
        {
          id: "step-1",
          intent: "create assets/manifest.json referencing icon.svg",
          status: "pending",
          attempts: 0,
          dependencies: [],
          executionGroup: undefined,
          successCriteria: [
            { kind: "directory_exists", path: "assets" },
            { kind: "file_contains", path: "assets/manifest.json", pattern: "icon.svg" },
          ],
        },
      ]),
    perform: async (_stepId, workspace) => {
      await writeWorkspaceFile(
        workspace,
        join("assets", "manifest.json"),
        '{\n  "icons": ["icon.svg"]\n}\n',
      );
    },
  },
];

export async function seedFixture(workspace: string, extra?: readonly FixtureFile[]): Promise<void> {
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "test"), { recursive: true });
  for (const f of [...SAMPLE_PROJECT, ...(extra ?? [])]) {
    await writeFile(join(workspace, f.path), f.content, "utf8");
  }
}

export async function removeWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
}

export async function ensureWorkspaceRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
}

export { ScriptedRuntime };
