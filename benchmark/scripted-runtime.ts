import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentRuntime,
  CreateSessionOptions,
  PromptOptions,
  RuntimeSession,
  TurnResult,
} from "../src/runtime/interface.ts";
import { writeFile } from "node:fs/promises";

export class ScriptedRuntime implements AgentRuntime {
  private attempts = new Map<string, number>();

  constructor(private readonly perform: (stepId: string, workspace: string, attempt: number) => Promise<void>) {}

  async createSession(opts: CreateSessionOptions): Promise<RuntimeSession> {
    const directory = resolve(opts.workspace);
    await mkdir(directory, { recursive: true });
    return { id: `bench-${randomUUID()}`, taskId: opts.taskId, directory };
  }

  async prompt(session: RuntimeSession, message: string, _opts?: PromptOptions): Promise<TurnResult> {
    const m = message.match(/step:\s*(\S+)/i);
    const stepId = m?.[1] ?? "unknown-step";
    const attempt = (this.attempts.get(stepId) ?? 0) + 1;
    this.attempts.set(stepId, attempt);
    try {
      await this.perform(stepId, session.directory, attempt);
      return { success: true, text: `DONE ${stepId}`, error: undefined };
    } catch (err) {
      return { success: false, text: "", error: err instanceof Error ? err.message : String(err) };
    }
  }

  async abort(_session: RuntimeSession): Promise<void> {}

  async destroy(_session: RuntimeSession): Promise<void> {}
}

export async function writeWorkspaceFile(
  workspace: string,
  relPath: string,
  content: string,
): Promise<void> {
  const full = join(workspace, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf8");
}
