export const TASK_SCHEMA_VERSION = 3;

type Migration = {
  from: number;
  to: number;
  migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
};

const MIGRATIONS: readonly Migration[] = [
  {
    from: 0,
    to: 1,
    migrate: (raw) => ({
      ...raw,
      fixCount: typeof raw.fixCount === "number" ? raw.fixCount : 0,
    }),
  },
  {
    from: 1,
    to: 2,
    migrate: (raw) => ({
      ...raw,
      currentStepId: typeof raw.currentStepId === "string" ? raw.currentStepId : null,
      runtime:
        typeof raw.runtime === "object" && raw.runtime !== null
          ? raw.runtime
          : null,
      lastEvaluation: "lastEvaluation" in raw ? raw.lastEvaluation : null,
    }),
  },
  {
    from: 2,
    to: 3,
    migrate: (raw) => ({
      ...raw,
      // A-2 (in-place execution): tasks gain a canonical workspace. Legacy v2
      // tasks were sandboxed under ~/.forge/tasks and are display-only — their
      // resume is blocked by TaskManager (workspacePath === null marker).
      workspacePath: typeof raw.workspacePath === "string" ? raw.workspacePath : null,
      projectId: typeof raw.projectId === "string" ? raw.projectId : null,
    }),
  },
];

/** Stamp schemaVersion on a task before persisting. */
export function stampSchemaVersion(task: Record<string, unknown>): Record<string, unknown> {
  return { ...task, schemaVersion: TASK_SCHEMA_VERSION };
}

/**
 * Read a persisted task and apply all migrations to reach the current
 * schema version. Handles v0 (pre-versioning), v1, v2, and v3.
 */
export function migrateTask(raw: Record<string, unknown>): Record<string, unknown> {
  let version =
    typeof raw.schemaVersion === "number"
      ? raw.schemaVersion
      : detectLegacyVersion(raw);

  let data = { ...raw };
  for (const migration of MIGRATIONS) {
    if (version < migration.to && version >= migration.from) {
      data = migration.migrate(data);
    }
    if (migration.to > version) version = migration.to;
  }

  return { ...data, schemaVersion: TASK_SCHEMA_VERSION };
}

function detectLegacyVersion(raw: Record<string, unknown>): number {
  if ("currentStepId" in raw || "runtime" in raw) return 2;
  if ("fixCount" in raw) return 1;
  return 0;
}
