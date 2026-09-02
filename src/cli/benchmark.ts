#!/usr/bin/env node
import { prepareBenchRoot } from "../../benchmark/env-first.ts";
import { join } from "node:path";
import { GOLDEN_TASKS } from "../../benchmark/golden.ts";
import { runGoldenTask } from "../../benchmark/harness.ts";
import { summarize } from "../../benchmark/metrics.ts";

function parseArgs(argv: readonly string[]): { only: string | undefined; keep: boolean } {
  let only: string | undefined;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--only") {
      const v = argv[i + 1];
      i++;
      if (v) only = v;
    } else if (a === "--keep") {
      keep = true;
    }
  }
  return { only, keep };
}

async function main(): Promise<void> {
  const { only, keep } = parseArgs(process.argv.slice(2));

  const selected = only ? GOLDEN_TASKS.filter((t) => t.id === only || t.category === only) : [...GOLDEN_TASKS];
  if (selected.length === 0) {
    console.error(`forge benchmark: no task matches '${only}'`);
    console.error(`available: ${GOLDEN_TASKS.map((t) => t.id).join(", ")}`);
    process.exit(2);
  }

  console.log("==== Forge Benchmark — Golden Tasks ====");
  console.log(`tasks: ${selected.map((t) => t.id).join(", ")}`);

  await prepareBenchRoot();

  const results = [];
  for (const task of selected) {
    results.push(await runGoldenTask({ task, keepWorkspace: keep }));
  }

  const summary = summarize(results);

  console.log("\n==== Per-task Results ====");
  console.log(
    "id".padEnd(16) +
      "cat".padEnd(15) +
      "state".padEnd(9) +
      "wall(ms)".padStart(9) +
      "retry".padStart(6) +
      "fix".padStart(4) +
      "rev".padStart(4) +
      "vfail".padStart(6) +
      "rfail".padStart(6) +
      "score".padStart(7),
  );
  for (const m of results) {
    console.log(
      m.taskId.padEnd(16) +
        m.category.padEnd(15) +
        m.finalState.padEnd(9) +
        String(m.wallMs).padStart(9) +
        String(m.retries).padStart(6) +
        String(m.fixCount).padStart(4) +
        String(m.planRevisions).padStart(4) +
        String(m.verificationFailures).padStart(6) +
        String(m.runtimeFailures).padStart(6) +
        String(m.evaluationScore ?? "-").padStart(7),
    );
  }

  console.log("\n==== Summary ====");
  console.log(`success rate:        ${summary.successCount}/${summary.total} (${summary.successRate})`);
  console.log(`total wall:          ${summary.totalWallMs}ms (avg ${summary.avgWallMs}ms/task)`);
  console.log(`retries:             ${summary.totalRetries}`);
  console.log(`fix count:           ${summary.totalFixCount}`);
  console.log(`plan revisions:      ${summary.totalPlanRevisions}`);
  console.log(`verification fails:  ${summary.totalVerificationFailures}`);
  console.log(`runtime failures:    ${summary.totalRuntimeFailures}`);
  console.log(`avg eval score:      ${summary.avgEvaluationScore}`);

  process.exit(summary.successCount === summary.total ? 0 : 1);
}

main().catch((err) => {
  console.error("forge benchmark:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
