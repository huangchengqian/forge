# 26 — Phase 6: Benchmark（golden tasks）

> 决策归属：Anvil 起草，PM 拍板
> 触发：Phase 1-5 从未跑过一个被观测的完整任务；RECOVERY/COMPACTION/GUARDRAILS 全部停在单元+冒烟级验证
> 前置：ROADMAP §7 原案（scripted-runtime / harness / metrics / 4 golden tasks）
> 写入时间：2026-09-09

---

## 1. 目标

Golden tasks 端到端验证架构成立：真实 Pi agentLoop + 真实工具执行（临时 workspace）+ 全套 guardrail hooks + 事件日志，只有 LLM 是确定性的脚本。**这是 Phase 1-5 的验收证明，也是未来激进重构的回归网。**

## 2. 不做的事

- 不联网、不依赖真实 provider（真实模型回归 = 后续 D 项，等 API key，harness 直接换 streamFn 即可）
- 不做 resume-golden（smoke-recovery 已覆盖 recovery 路径）
- 不做性能基准（wall 时间只报告不断言）

## 3. 组件

### 3.1 `src/benchmark/scripted-runtime.ts`

- `scriptedAssistantMessage(content, stopReason)` — 构造 AssistantMessage（固定 usage，cost=0）
- `makeScriptedStreamFn(script: AssistantMessage[])` — StreamFn 工厂：每次调用按序吐下一条（EventStream push done），脚本耗尽后吐兜底 "done"（并标记脚本越界，断言可检测）
- 脚本条目形如 `{type:"toolCall", id, name, arguments}`（stopReason "toolUse"）或纯 text（"stop"）——与 smoke-verification 的已验证模式一致

### 3.2 `src/benchmark/harness.ts`

`runGoldenTask(task): Promise<TaskReport>`
1. mkdtemp workspace + 独立 `FORGE_EVENTS_DIR` / `FORGE_SESSIONS_DIR`
2. 构造 Session（status running）+ GuardrailConfig（全套 hooks：beforeToolCall/afterToolCall/shouldStopAfterTurn/transformContext/prepareNextTurn/getSteeringMessages）
3. `runAgent({session, model: fakeModel, guardrails, streamFn})`，异常捕获 → state=failed + failureReason
4. 读事件日志 → `metrics.ts` 提取指标 → 执行 task.assert() → TaskReport

### 3.3 `src/benchmark/metrics.ts`

从 session 终态 + 事件日志提取：`state / wallMs / turns / cost / vfail / vpass / evalScore / stuckPatterns / retries`（retries = 脚本中 error-stopReason 条数，golden 全为 0）。

### 3.4 `src/benchmark/tasks.ts` — 4 个 golden task

| Task | 类别 | 脚本 | 断言 |
|---|---|---|---|
| `golden_create_file` | new-feature | write hello.txt → done（medium trust，criterion: file_contains "hello"） | state=completed、vfail=0、文件存在且含 "hello"、VERIFICATION passed=true |
| `golden_verify_fail` | new-feature | 写入缺 export → done →（verification fail→steering）→ 写修复 → done（high trust + file_contains "export"） | vfail 序列 = [false, true]、终态文件含 export、state=completed、evalScore 存在 |
| `golden_stuck_loop` | recovery | 同一 write（同参数同内容）×6 | STUCK_WARNING 事件存在且 pattern=action_observation_loop、循环提前终止（脚本未耗尽）、状态为终止态 |
| `golden_multi_step` | new-feature | write util.ts → write main.ts（引用 util）→ done（medium，双 criterion：两文件 file_contains） | 两文件内容正确、state=completed、vfail=0 |

### 3.5 `src/cli/benchmark.ts`

输出 ROADMAP §7 格式报告，任一断言失败 exit 1：

```
=== golden_create_file [new-feature] Create hello.txt
  -> state=completed wall=120ms turns=4 cost=$0.0000 vfail=0 eval=-
```

## 4. 门禁

- `scripts/release-check.sh` Integration 段新增 `benchmark golden tasks`（22 → 23 项）
- 单元级：metrics 提取的纯函数单测（可后补，冒烟覆盖先行）

## 5. 风险

- **stuck 终止的下游表现未经验证**：`afterToolCall {terminate:true}` 在 Pi loop 里是异常抛出还是正常收尾，golden_stuck_loop 首跑确定；断言按"提前终止 + STUCK_WARNING 存在"写，不锁死 status
- **criteria 验证依赖真实文件系统**——已用 mkdtemp 隔离，`command_exit_zero` 类 criterion（npm test）在 golden 中不使用
- **事件目录串场**——每 task 独立 `FORGE_EVENTS_DIR`，顺序执行无并发

## 6. 首跑战果（2026-09-09，4/4 PASS + 抓到 1 个真 bug）

Benchmark 第一跑就命中一个真实缺陷，正是它存在的意义：

- **guardrail 击杀不落 failureReason**：`afterToolCall {terminate:true}` 让 Pi loop **优雅返回**（不抛异常），没有任何代码记录"为什么终止"。真实服务路径里 `SessionManager.settle` 按 `failureReason ? failed : completed` 判定——**被 stuck guard 杀掉的 session 会被标成 completed**，UI 和审计全被误导。maxTurns 耗尽、cost 预算耗尽两个硬停止同样不落 reason。
- **修复**（与 golden 同 commit）：
  - `after-tool-call.ts`：terminate 前落 `session.failureReason = "stuck detected: {pattern} ({n} repetitions)"`
  - `should-stop-after-turn.ts`：cost 耗尽 / maxTurns 耗尽两个硬停止落 failureReason（`??=` 不覆盖已有 reason）
  - harness/metrics 按 failureReason 派生终态（直接 runAgent 没有 settle 逻辑）
- golden_stuck_loop 断言相应收紧：`state=failed && failureReason startsWith "stuck detected"`
