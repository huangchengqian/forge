import type { TaskSession } from "../core/types/task-session.ts";
import type { MemoryItem } from "./types.ts";
import { addMemory } from "./store.ts";

export type ExtractedFact = {
  type: "PROJECT_FACT" | "DECISION" | "FAILURE_PATTERN" | "SOLUTION";
  content: string;
  source: "VERIFICATION" | "OBSERVATION" | "USER" | "REPO";
  confidence: number;
  keywords: readonly string[];
};

export async function extractFromTask(task: TaskSession): Promise<readonly MemoryItem[]> {
  const facts = proposeFacts(task);
  const stored: MemoryItem[] = [];
  for (const f of facts) {
    const item = await addMemory({
      type: f.type,
      content: f.content,
      source: f.source,
      confidence: f.confidence,
      keywords: f.keywords,
      taskRefs: [task.id],
    });
    stored.push(item);
  }
  return stored;
}

function proposeFacts(task: TaskSession): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const allObservations = task.observations;
  const failedObs = allObservations.filter((o) => o.result === "FAIL");
  const passedObs = allObservations.filter((o) => o.result === "PASS");
  const baseKeywords = extractKeywords(task.goal);

  if (task.state === "COMPLETE") {
    if (passedObs.length > 0 && allObservations.length > 0 && failedObs.length === 0) {
      facts.push({
        type: "PROJECT_FACT",
        content: `${task.goal} (validated by ${passedObs.length} observation(s))`,
        source: "VERIFICATION",
        confidence: 0.9,
        keywords: [...baseKeywords, "validated"],
      });
    }
    if (passedObs.length > 0) {
      facts.push({
        type: "SOLUTION",
        content: `Working approach succeeded for: ${task.goal}`,
        source: "VERIFICATION",
        confidence: 0.7,
        keywords: [...baseKeywords, "solution"],
      });
    }
  }

  if (task.state === "FAILED") {
    if (failedObs.length >= 2) {
      const lastFailure = failedObs[failedObs.length - 1];
      const reason = lastFailure?.failureReason ?? task.failureReason ?? "unknown";
      facts.push({
        type: "FAILURE_PATTERN",
        content: `${task.goal} — failure pattern: ${reason}`,
        source: "OBSERVATION",
        confidence: 0.8,
        keywords: [...baseKeywords, "failure"],
      });
    }
  }

  return facts;
}

export function extractKeywords(goal: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of goal.toLowerCase().split(/[^a-z0-9]+/u)) {
    const t = raw.trim();
    if (t.length < 3) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
