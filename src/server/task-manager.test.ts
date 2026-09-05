import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// Isolation: env vars must be set BEFORE the dynamic imports below, because
// persistence/engine modules capture paths in module-level constants.
const TMP = "/tmp/forge-task-manager-tests";
process.env.FORGE_HOME = TMP;
process.env.FORGE_TASKS_DIR = join(TMP, "tasks");
process.env.FORGE_EVENTS_DIR = join(TMP, "events");
process.env.FORGE_MEMORY_PATH = join(TMP, "memory.json");
for (const k of [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
]) delete process.env[k];

const { TaskManager, CreateTaskError } = await import("./task-manager.ts");
const { ProjectsRegistry } = await import("./projects.ts");
const { EventBus } = await import("../events/index.ts");
const { RuntimeSupervisor } = await import("./runtime-supervisor.ts");
const { ApprovalHub } = await import("./approval-hub.ts");
const { saveTask } = await import("../core/persistence/task-store.ts");
const { randomUUID } = await import("node:crypto");
import type { TaskSession } from "../core/types/task-session.ts";

type Manager = InstanceType<typeof TaskManager>;
type Registry = InstanceType<typeof ProjectsRegistry>;

const PROJECT_DIR = join(TMP, "project-a");

function makeManager(
  projects: Registry,
  forgeHome = TMP,
  runtimeKind: "fake" | "pi" = "fake",
  intentRouter?: { classify: (input: string) => Promise<{ kind: "conversation"; reply: string } | { kind: "task" }> },
): Manager {
  return new TaskManager({
    bus: new EventBus(),
    forgeHome,
    runtimeKind,
    defaultProvider: "anthropic",
    defaultModelId: "claude-opus-4-8",
    maxConcurrency: undefined,
    supervisor: new RuntimeSupervisor(() => {}),
    projects,
    approvalHub: new ApprovalHub(),
    ...(intentRouter ? { intentRouter } : {}),
  });
}

let projects: Registry;
let manager: Manager;
let projectA: { id: string; path: string };

before(async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(PROJECT_DIR), { recursive: true });
  await mkdir(join(TMP, "tasks"), { recursive: true });
  // FakeRuntime's default criterion is file_exists output.txt — seed it so
  // project-bound tasks run to COMPLETE quickly.
  await writeFile(join(PROJECT_DIR, "output.txt"), "ok\n", "utf8");

  projects = new ProjectsRegistry(TMP);
  projectA = await projects.register({ path: PROJECT_DIR, name: "project-a" });
  manager = makeManager(projects);
});

after(async () => {
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("TaskManager workspace binding", () => {
  test("create with explicit projectId binds task.directory to the project path", async () => {
    const { taskId } = await manager.create({ goal: "bind explicit", projectId: projectA.id });
    const task = await manager.get(taskId);
    assert.ok(task);
    assert.equal(task.directory, PROJECT_DIR);
    await manager.whenSettled(taskId);
    assert.equal((await manager.get(taskId))?.state, "COMPLETE");
  });

  test("create without projectId inherits the active project", async () => {
    // projects.register() selected projectA as active in `before`.
    const { taskId } = await manager.create({ goal: "bind inherit" });
    const task = await manager.get(taskId);
    assert.ok(task);
    assert.equal(task.directory, PROJECT_DIR);
    await manager.whenSettled(taskId);
  });

  test("create with unknown projectId → 400", async () => {
    await assert.rejects(
      manager.create({ goal: "x", projectId: "prj_missing" }),
      (err: unknown) => err instanceof CreateTaskError && err.status === 400,
    );
  });

  test("create without any project falls back to the per-task directory", async () => {
    const emptyHome = join(TMP, "empty-home");
    const emptyRegistry = new ProjectsRegistry(emptyHome);
    const m2 = makeManager(emptyRegistry, emptyHome);
    const { taskId } = await m2.create({ goal: "fallback test" });
    const task = await m2.get(taskId);
    assert.ok(task);
    assert.equal(task.directory, join(emptyHome, "tasks", taskId));
    await m2.whenSettled(taskId);
  });
});

describe("TaskManager workspace locking", () => {
  test("second concurrent task on the same workspace → 409; lock releases after settle", async () => {
    process.env.FORGE_FAKE_DELAY_MS = "1200";
    try {
      const { taskId: first } = await manager.create({ goal: "lock holder", projectId: projectA.id });
      await assert.rejects(
        manager.create({ goal: "lock contender", projectId: projectA.id }),
        (err: unknown) => err instanceof CreateTaskError && err.status === 409,
      );
      await manager.whenSettled(first);
      const { taskId: third } = await manager.create({ goal: "after release", projectId: projectA.id });
      await manager.whenSettled(third);
      assert.equal((await manager.get(third))?.state, "COMPLETE");
    } finally {
      delete process.env.FORGE_FAKE_DELAY_MS;
    }
  });
});

describe("TaskManager cancellation", () => {
  test("cancel converges to the explicit CANCELLED terminal state", async () => {
    process.env.FORGE_FAKE_DELAY_MS = "300";
    try {
      const { taskId } = await manager.create({ goal: "cancel me", projectId: projectA.id });
      const settle = manager.whenSettled(taskId);
      const result = await manager.cancel(taskId);
      assert.equal(result.cancelled, true);
      const settled = await settle;
      assert.equal(settled?.state, "CANCELLED");
      assert.equal((await manager.get(taskId))?.state, "CANCELLED");
    } finally {
      delete process.env.FORGE_FAKE_DELAY_MS;
    }
  });
});

describe("TaskManager preflight", () => {
  test("ok when project exists and runtime is fake", async () => {
    const r = await manager.preflight({ projectId: projectA.id });
    assert.equal(r.ok, true);
    assert.equal(r.workspace.source, "project");
    assert.equal(r.workspace.path, PROJECT_DIR);
    assert.equal(r.workspace.exists, true);
    assert.equal(r.workspace.writable, true);
    assert.equal(r.lock.available, true);
    assert.deepEqual(r.problems, []);
  });

  test("reports missing credentials for the pi runtime (audit B3)", async () => {
    const pi = makeManager(projects, TMP, "pi");
    const r = await pi.preflight({ projectId: projectA.id });
    assert.equal(r.ok, false);
    assert.equal(r.provider.envConfigured, false);
    assert.equal(r.provider.envVar, "ANTHROPIC_API_KEY");
    assert.ok(r.problems.some((p) => p.includes("no API key configured")));
  });

  test("reports unknown projectId as a problem", async () => {
    const r = await manager.preflight({ projectId: "prj_missing" });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes("no such project")));
  });
});

describe("TaskManager approval relay (9.6.5)", () => {
  test("listApprovals returns hub records; approve on fake runtime → unsupported", async () => {
    const hub = new ApprovalHub();
    const m = new TaskManager({
      bus: new EventBus(),
      forgeHome: TMP,
      runtimeKind: "fake",
      defaultProvider: "anthropic",
      defaultModelId: "claude-opus-4-8",
      maxConcurrency: undefined,
      supervisor: new RuntimeSupervisor(() => {}),
      projects,
      approvalHub: hub,
    });

    process.env.FORGE_FAKE_DELAY_MS = "800";
    try {
      const { taskId } = await m.create({ goal: "approval relay", projectId: projectA.id });
      hub.record({ requestId: "r1", taskId, method: "confirm", title: "Allow bash?", message: "{}", at: Date.now() });

      assert.equal(m.listApprovals(taskId).length, 1);
      assert.equal(m.listApprovals(taskId)[0]?.requestId, "r1");

      const r = await m.approve(taskId, "r1");
      assert.equal(r.ok, false);
      assert.match(r.message, /does not support approvals/);
      // record stays pending because the runtime never delivered it
      assert.equal(hub.get("r1")?.status, "pending");

      const r2 = await m.approve(taskId, "ghost");
      assert.equal(r2.ok, false);
      assert.match(r2.message, /no pending approval/);

      await m.whenSettled(taskId);
    } finally {
      delete process.env.FORGE_FAKE_DELAY_MS;
    }
  });

  test("approve on inactive task → not active", async () => {
    const m = makeManager(projects);
    const r = await m.approve("task_never_started", "r1");
    assert.equal(r.ok, false);
    assert.match(r.message, /not active/);
  });

  test("approve always=true persists an allow rule to guard.json (isolated policy path)", async () => {
    const hub = new ApprovalHub();
    const policyFile = join(TMP, "guard-always.json");
    const m = new TaskManager({
      bus: new EventBus(),
      forgeHome: TMP,
      runtimeKind: "fake",
      defaultProvider: "anthropic",
      defaultModelId: "claude-opus-4-8",
      maxConcurrency: undefined,
      supervisor: new RuntimeSupervisor(() => {}),
      projects,
      approvalHub: hub,
    });

    process.env.FORGE_GUARD_POLICY = policyFile;
    try {
      const { taskId } = await m.create({ goal: "always allow relay", projectId: projectA.id });
      hub.record({
        requestId: "r-always",
        taskId,
        method: "confirm",
        title: "Allow bash?",
        message: JSON.stringify({ command: "pwd && ls -la" }),
        at: Date.now(),
      });

      const r = await m.approve(taskId, "r-always", true);
      // rule persistence happens before the runtime delivery attempt, so the
      // rule file is written even though the fake runtime can't deliver.
      const policy = JSON.parse(readFileSync(policyFile, "utf8"));
      assert.ok(
        policy.rules.some((x: { capability: string; contains?: string; decision: string }) =>
          x.capability === "bash" && x.contains === "pwd && ls -la" && x.decision === "allow"),
        "always-allow rule persisted",
      );
      assert.ok(
        policy.rules.some((x: { capability: string; decision: string }) =>
          x.capability === "destructive" && x.decision === "deny"),
        "defaults preserved alongside user rule",
      );
      void r; // runtime delivery fails on fake runtime — expected, rule already written
      await m.whenSettled(taskId);
    } finally {
      delete process.env.FORGE_GUARD_POLICY;
    }
  });
});

describe("TaskManager credential fail-fast at create (audit B3)", () => {
  test("pi runtime without any provider key → 400 before spawning Pi", async () => {
    const pi = makeManager(projects, TMP, "pi");
    await assert.rejects(
      pi.create({ goal: "no key" }),
      (err: unknown) => err instanceof CreateTaskError && err.status === 400 && /no API key/.test(err.message),
    );
  });
});

describe("TaskManager resume after schema v3 (A-2 migration guard)", () => {
  test("legacy v2 task (workspacePath null after migration) → resume rejected", async () => {
    // Write a v2-format task directly to disk, as a pre-A-2 task would be.
    const { writeFile } = await import("node:fs/promises");
    const v2 = {
      id: "legacy-v2",
      goal: "legacy goal",
      state: "EXECUTE",
      plan: null,
      currentStepId: null,
      observations: [],
      piSessionId: "pi-x",
      directory: join(TMP, "tasks", "legacy-v2"),
      model: { provider: "fake", modelId: "fake" },
      runtime: null,
      fixCount: 0,
      createdAt: Date.now() - 86_400_000,
      updatedAt: Date.now() - 86_400_000,
      failureReason: null,
      schemaVersion: 2,
    };
    const { taskPath } = await import("../core/persistence/json.ts");
    await writeFile(taskPath("legacy-v2"), JSON.stringify(v2), "utf8");

    const r = await manager.resume("legacy-v2");
    assert.equal(r.resumed, false);
    assert.match(r.message, /schema v3/);
  });

  test("v3 task with workspacePath → resume proceeds to COMPLETE", async () => {
    const now = Date.now();
    const task: TaskSession = {
      id: "resume-v3",
      goal: "resume v3 task",
      state: "EXECUTE",
      plan: {
        id: randomUUID(),
        version: 1,
        objective: "resume v3 task",
        steps: [
          {
            id: "step-1",
            intent: "produce output.txt",
            status: "pending",
            attempts: 0,
            dependencies: [],
            executionGroup: undefined,
            successCriteria: [{ kind: "file_exists", path: "output.txt" }],
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      currentStepId: "step-1",
      observations: [],
      runtime: null,
      piSessionId: null,
      directory: PROJECT_DIR,
      workspacePath: PROJECT_DIR,
      projectId: projectA.id,
      model: { provider: "fake", modelId: "fake" },
      fixCount: 0,
      createdAt: now,
      updatedAt: now,
      failureReason: null,
      lastEvaluation: null,
    };
    await saveTask(task);

    const r = await manager.resume("resume-v3");
    assert.equal(r.resumed, true);
    const settled = await manager.whenSettled("resume-v3");
    assert.ok(settled);
    assert.equal(settled.state, "COMPLETE");
  });
});

describe("TaskManager Phase 9.7 routing", () => {
  test("conversation intent → lightweight record: no plan, no runtime, no workspace lock", async () => {
    const m = makeManager(projects, TMP, "fake", {
      classify: async () => ({ kind: "conversation", reply: "你好！有什么可以帮你？" }),
    });
    const { taskId } = await m.create({ goal: "你好", projectId: projectA.id });
    const task = await m.get(taskId);
    assert.ok(task);
    assert.equal(task.kind, "conversation");
    assert.equal(task.state, "COMPLETE");
    assert.equal(task.plan, null);
    assert.equal(task.observations.length, 0);
    assert.equal(task.fixCount, 0);
    assert.equal(task.runtime, null);
    assert.equal(task.workspacePath, PROJECT_DIR);
    // Conversation never enters the active set: no run promise, no lock held.
    assert.equal(m.whenSettled(taskId), null);
    // Reply is streamed into the event log as agent text.
    const { readEvents } = await import("../core/persistence/event-log.ts");
    const events = await readEvents(taskId);
    const text = events
      .filter((e) => e.type === "AGENT_EVENT")
      .map((e) => (e.payload?.piEvent as { assistantMessageEvent?: { delta?: string } })?.assistantMessageEvent?.delta ?? "")
      .join("");
    assert.ok(text.includes("你好！有什么可以帮你？"));
  });

  test("task intent → engineering pipeline runs unchanged", async () => {
    const m = makeManager(projects, TMP, "fake", {
      classify: async () => ({ kind: "task" }),
    });
    const { taskId } = await m.create({ goal: "produce output.txt", projectId: projectA.id });
    await m.whenSettled(taskId);
    const task = await m.get(taskId);
    assert.ok(task);
    assert.equal(task.kind, undefined); // task sessions keep the legacy shape
    assert.equal(task.state, "COMPLETE");
    assert.equal(task.observations.length, 1);
  });

  test("conversation continued turn routes to the chat channel (no Pi session needed)", async () => {
    const m = makeManager(projects, TMP, "fake", {
      classify: async () => ({ kind: "conversation", reply: "hi" }),
    });
    const { taskId } = await m.create({ goal: "hello", projectId: projectA.id });
    // No forge-config.json in the test home → the chat channel reports the
    // missing provider instead of "no active or idle session", proving the
    // conversation branch was taken without a Pi runtime.
    const r = await m.message(taskId, "继续聊聊");
    assert.equal(r.ok, false);
    assert.match(r.message, /provider configured/);
    const { readEvents } = await import("../core/persistence/event-log.ts");
    const events = await readEvents(taskId);
    const hasUser = events.some(
      (e) => e.type === "AGENT_EVENT" &&
        (e.payload?.piEvent as { type?: string })?.type === "user_message",
    );
    assert.ok(hasUser);
  });
});
