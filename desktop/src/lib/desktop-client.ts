import type { TaskSession, MemoryItem } from "../shared/types.ts";

export type EventEnvelope = {
  seq: number;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
};

export type DesktopConfig = { baseUrl: string; token: string };

let cfg: DesktopConfig | null = null;
export function initClient(c: DesktopConfig) { cfg = c; }
function headers() {
  if (!cfg) throw new Error("client not initialised");
  return { authorization: `Bearer ${cfg.token}` };
}
async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${cfg!.baseUrl}${path}`, { headers: headers() });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json() as Promise<T>;
}
export async function fetchTaskList(): Promise<TaskSession[]> {
  return (await getJson<{ tasks: TaskSession[] }>("/tasks")).tasks;
}
export async function fetchTask(id: string): Promise<TaskSession> {
  return getJson(`/tasks/${id}`);
}
export async function fetchMemory(): Promise<MemoryItem[]> {
  return (await getJson<{ items: MemoryItem[] }>("/memory")).items;
}

export async function deleteMemory(id: string): Promise<void> {
  const r = await fetch(`${cfg!.baseUrl}/memory/${id}`, { method: "DELETE", headers: headers() });
  if (!r.ok) throw new Error(`DELETE /memory/${id} → ${r.status}`);
}
export function streamUrl(taskId: string): string {
  return `${cfg!.baseUrl}/tasks/${taskId}/stream?token=${encodeURIComponent(cfg!.token)}`;
}

export type ApprovalRecord = {
  requestId: string;
  taskId: string;
  method: string;
  title: string;
  message: string;
  at: number;
  status: string;
};

export async function fetchApprovals(taskId: string): Promise<ApprovalRecord[]> {
  return (await getJson<{ approvals: ApprovalRecord[] }>(`/tasks/${taskId}/approvals`)).approvals;
}

export async function resolveApproval(taskId: string, requestId: string, decision: "approve" | "deny"): Promise<void> {
  const r = await fetch(`${cfg!.baseUrl}/tasks/${taskId}/approvals/${requestId}/${decision}`, {
    method: "POST",
    headers: headers(),
  });
  if (!r.ok) throw new Error(`POST approvals/${decision} → ${r.status}`);
}

export type DiffResult =
  | { kind: "git"; head: string; diff: string; status: string }
  | {
      kind: "journal";
      files: Array<{ path: string; backup: boolean; action: string; size: number; exists: boolean }>;
    }
  | { kind: "none"; reason: string };

export async function fetchDiff(taskId: string): Promise<DiffResult> {
  return getJson<DiffResult>(`/tasks/${taskId}/diff`);
}

export async function undoTask(taskId: string): Promise<{ restored: number; files: string[] }> {
  const r = await fetch(`${cfg!.baseUrl}/tasks/${taskId}/undo`, { method: "POST", headers: headers() });
  if (!r.ok) throw new Error(`POST undo → ${r.status}`);
  return r.json() as Promise<{ restored: number; files: string[] }>;
}

export async function sendMessage(taskId: string, message: string): Promise<void> {
  const r = await fetch(`${cfg!.baseUrl}/tasks/${taskId}/message`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!r.ok) throw new Error(`POST message → ${r.status}`);
}

export async function deleteSession(taskId: string): Promise<void> {
  const r = await fetch(`${cfg!.baseUrl}/tasks/${taskId}`, { method: "DELETE", headers: headers() });
  if (!r.ok) throw new Error(`DELETE /tasks/${taskId} → ${r.status}`);
}

export type ProviderConfig = {
  id: string;
  api: string;
  apiKey: string;
  modelId: string;
  baseUrl: string;
};

export type ForgeConfigData = {
  providers: ProviderConfig[];
  defaultProviderId: string | null;
  maxConcurrency: number;
};

export async function getConfig(): Promise<ForgeConfigData> {
  return getJson("/config");
}

export async function saveConfig(config: Partial<ForgeConfigData>): Promise<void> {
  const r = await fetch(`${cfg!.baseUrl}/config`, {
    method: "PUT", headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!r.ok) throw new Error(`PUT /config → ${r.status}`);
}

export type CheckResult = {
  name: string;
  status: "PASS" | "FAIL" | "SKIP" | "WARNING";
  message: string;
  durationMs?: number;
};

export type ProviderCheckResult = {
  status: "PASS" | "WARNING" | "FAIL";
  checks: readonly CheckResult[];
};

export async function testConnection(provider: Record<string, string>): Promise<{
  provider: ProviderCheckResult;
  runtime: ProviderCheckResult | null;
  status: string;
}> {
  const r = await fetch(`${cfg!.baseUrl}/config/test`, {
    method: "POST", headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify(provider),
  });
  if (!r.ok) throw new Error(`POST /config/test → ${r.status}`);
  return r.json() as Promise<{
    provider: ProviderCheckResult;
    runtime: ProviderCheckResult | null;
    status: string;
  }>;
}

export async function createTask(input: { goal: string; provider?: string; modelId?: string; providerId?: string; maxConcurrency?: number }): Promise<{ taskId: string; state: string }> {
  const r = await fetch(`${cfg!.baseUrl}/tasks`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`POST /tasks → ${r.status}`);
  return r.json() as Promise<{ taskId: string; state: string }>;
}
