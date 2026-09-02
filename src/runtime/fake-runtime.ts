import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentRuntime,
  CreateSessionOptions,
  PromptOptions,
  RuntimeSession,
  TurnResult,
} from "./interface.ts";
import type { SuccessCriterion } from "../core/types/criterion.ts";

export type FakeStep = {
  intent: string;
  criteria: readonly SuccessCriterion[];
};

export type FakePlan = {
  steps: readonly FakeStep[];
};

export class FakeRuntime implements AgentRuntime {
  promptCalls: string[] = [];
  abortCalls = 0;
  destroyCalls = 0;

  constructor(
    private readonly forgeHome: string,
    private readonly plan: FakePlan,
    private readonly understandText = "",
  ) {}

  async createSession(opts: CreateSessionOptions): Promise<RuntimeSession> {
    const dir = resolve(opts.workspace);
    await mkdir(dir, { recursive: true });
    return { id: `fake-${randomUUID()}`, taskId: opts.taskId, directory: dir };
  }

  async prompt(session: RuntimeSession, message: string, _opts?: PromptOptions): Promise<TurnResult> {
    this.promptCalls.push(message);
    // The planner prompt asks for a JSON plan with a "suggestedSteps" field;
    // match on that (wording-independent) marker to serve a fake plan.
    if (message.includes("suggestedSteps")) {
      if (this.understandText) {
        return { success: true, text: this.understandText, error: undefined };
      }
      const steps = this.plan.steps
        .map(
          (s, i) =>
            `{"intent":${JSON.stringify(s.intent)},"successCriteria":${JSON.stringify(s.criteria)}}`,
        )
        .join(",");
      return {
        success: true,
        text: `{"understanding":"fake","suggestedSteps":[${steps}]}`,
        error: undefined,
      };
    }
    return { success: true, text: "ok", error: undefined };
  }

  async abort(_session: RuntimeSession): Promise<void> {
    this.abortCalls++;
  }

  async destroy(session: RuntimeSession): Promise<void> {
    this.destroyCalls++;
    // RED LINE (docs/16 §3): never delete the session directory. In in-place
    // mode it is the user's real project directory.
    void session;
  }
}
