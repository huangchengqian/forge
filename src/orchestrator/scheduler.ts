import type { Plan } from "../core/types/plan.ts";
import type { PlanStep } from "../core/types/step.ts";

export type ReadyStep = PlanStep;

export const DEFAULT_MAX_CONCURRENCY = 2;

/**
 * Compute the set of steps whose dependencies are all satisfied (verified)
 * and which themselves are still pending. Returns them in plan order.
 */
export function computeReadySteps(plan: Plan, completedIds: ReadonlySet<string>): readonly ReadyStep[] {
  const ready: ReadyStep[] = [];
  for (const step of plan.steps) {
    if (step.status !== "pending") continue;
    const allDepsOk = step.dependencies.every((depId) => completedIds.has(depId));
    if (allDepsOk) ready.push(step);
  }
  return ready;
}

/**
 * Group steps by executionGroup (steps in same group may run concurrently).
 * If step has no group, it forms its own group of 1.
 * Returned groups preserve plan order within each group and group order.
 */
export function groupForConcurrency(steps: readonly ReadyStep[]): readonly (readonly ReadyStep[])[] {
  const byGroup = new Map<string, ReadyStep[]>();
  for (const s of steps) {
    const g = s.executionGroup ?? `__solo_${s.id}`;
    const arr = byGroup.get(g) ?? [];
    arr.push(s);
    byGroup.set(g, arr);
  }
  return Array.from(byGroup.values());
}

export class ExecutionScheduler {
  constructor(public readonly maxConcurrency: number) {}

  select(
    plan: Plan,
    completedIds: ReadonlySet<string>,
    runningIds: ReadonlySet<string>,
  ): readonly ReadyStep[] {
    const ready = computeReadySteps(plan, completedIds).filter(
      (s) => !runningIds.has(s.id),
    );
    const slots = Math.max(0, this.maxConcurrency - runningIds.size);
    if (slots <= 0) return [];
    const groups = groupForConcurrency(ready);
    const picked: ReadyStep[] = [];
    for (const group of groups) {
      if (picked.length + group.length > slots) continue;
      picked.push(...group);
      if (picked.length >= slots) break;
    }
    return picked;
  }
}
