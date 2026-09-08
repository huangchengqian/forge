export const SESSION_SCHEMA_VERSION = 4;

type Migration = {
  from: number;
  to: number;
  migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
};

/**
 * v3 → v4: TaskSession → Session.
 *
 * The legacy task model (state machine + plan + observations) collapses into
 * the single Session model: `status` replaces `state`, `messages` replaces
 * plan/observations as the carrier of truth. Unfinished legacy tasks map to
 * "cancelled" — the new loop has no mechanism to resume a state-machine
 * mid-point, and pretending otherwise would corrupt the audit trail.
 */
function mapTaskStateToSessionStatus(state: unknown): SessionStatusLike {
  switch (state) {
    case "COMPLETE":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      // READY / UNDERSTAND / PLAN / EXECUTE / OBSERVE / FIX / EVALUATE /
      // REVIEW_REQUIRED — no resumable counterpart in the new architecture.
      return "cancelled";
  }
}

type SessionStatusLike = "running" | "completed" | "failed" | "cancelled";

const MIGRATIONS: readonly Migration[] = [
  {
    from: 0,
    to: 4,
    migrate: (raw) => migrateLegacyTaskToSession(raw),
  },
  {
    from: 1,
    to: 4,
    migrate: (raw) => migrateLegacyTaskToSession(raw),
  },
  {
    from: 2,
    to: 4,
    migrate: (raw) => migrateLegacyTaskToSession(raw),
  },
  {
    from: 3,
    to: 4,
    migrate: (raw) => migrateLegacyTaskToSession(raw),
  },
];

function migrateLegacyTaskToSession(raw: Record<string, unknown>): Record<string, unknown> {
  const status = mapTaskStateToSessionStatus(raw.state);
  const legacyFailure =
    typeof raw.failureReason === "string" ? raw.failureReason : null;
  return {
    // carried over
    id: typeof raw.id === "string" ? raw.id.replace(/^task_/, "session_") : raw.id,
    goal: typeof raw.goal === "string" ? raw.goal : "",
    workspace:
      typeof raw.workspacePath === "string" && raw.workspacePath
        ? raw.workspacePath
        : typeof raw.directory === "string"
          ? raw.directory
          : "",
    projectId: typeof raw.projectId === "string" ? raw.projectId : null,
    model:
      raw.model && typeof raw.model === "object"
        ? raw.model
        : { provider: "unknown", modelId: "unknown" },
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    status,
    failureReason: legacyFailure ?? (status === "cancelled" ? "migrated from legacy task state" : null),
    cost: { total: 0, budget: null },
    trustLevel: "medium",
    completionCriteria: [],
    lastEvaluation: raw.lastEvaluation ?? null,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
    // legacy fields deliberately dropped:
    // state, plan, observations, fixCount, currentStepId, runtime, piSessionId
  };
}

/** Stamp schemaVersion on a session before persisting. */
export function stampSchemaVersion(session: Record<string, unknown>): Record<string, unknown> {
  return { ...session, schemaVersion: SESSION_SCHEMA_VERSION };
}

/**
 * Read a persisted session and apply migrations to reach the current schema
 * version. Handles legacy TaskSession files (v0-v3, `tasks/` era) and
 * current v4 sessions.
 */
export function migrateSession(raw: Record<string, unknown>): Record<string, unknown> {
  const version = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0;

  // Already current.
  if (version === SESSION_SCHEMA_VERSION) return { ...raw };

  let data = { ...raw };
  let current = version;
  for (const migration of MIGRATIONS) {
    if (current < migration.to && current >= migration.from) {
      data = migration.migrate(data);
      current = migration.to;
    }
  }

  return { ...data, schemaVersion: SESSION_SCHEMA_VERSION };
}
