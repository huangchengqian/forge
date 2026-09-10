# Forge 架构全量审视（里程碑节点）

审视日期：2026-09-10
审视基点：`f04d007`（master）
判定基准：`AGENTS.md`（架构宪法）+ `docs/ARCHITECTURE.md`
方法：机械可达性分析（`.audit-imports.mjs`，以 serve.ts / main.tsx / *.test.ts / preview.tsx 为根算可达集）+ 逐文件通读 `src/**`、`desktop/src/**`、`scripts/**`、根配置 + 对每条结论做 `文件:行号` 取证。**只审视，未改任何代码。**

---

## 0. 结论摘要

**总体架构方向是对的，代码质量高于这个项目的成熟度；但 Phase 1（49f1fda）那次"状态机 → 进程内 Pi agentLoop"的范式迁移留下了系统性遗留：凡是原先靠"每会话一个子进程 + 环境变量"承载的每会话配置，迁移后都没有了承载者——而测试因为显式传参，全部照常通过。**

三个最重的后果：

| # | 现象 | 一句话 |
|---|---|---|
| **P0-1** | Undo journal 在生产中从不写入 | 写前备份 / Diff / Undo 三条链路全死；而已免审批的写操作正是以"有 undo 兜底"为理由的 |
| **P0-2** | 用户 `~/.forge/guard.json` 从不被读取 | `loadPolicy()` 无参调用 = 永远用内置默认；"Always allow" 后端+UI 整条链路在 Phase 1 无声消失，只剩孤儿代码 |
| **P0-3** | 侧栏切换项目静默失效 | 路由不存在（404 被吞）+ Composer 用的是"当前会话的项目"而非"侧栏选的项目" → UI 显示已切换，实际 workspace 不变 |

体量上的死重：**`ui/`（16 文件，上一代 Plan/Step 前端）与 `benchmark/`（7 文件 800 行，被 `src/benchmark/` 取代）两个整目录零引用**，加起来约等于再造一个 `src/`；`package.json` 的 `build`/`start`/`demo` 指向已失效路径。

---

## 1. 宪法 vs 代码：声明与事实对照

| 宪法条款 | 代码事实 | 判定 |
|---|---|---|
| §3 "Forge 注入 guardrails as callbacks，Pi owns the loop" | `agent-runner.ts:138` `agentLoop(prompts, context, config, signal, streamFn)`，无外层 while | ✅ 一致 |
| §3 seam = `AgentLoopConfig hooks`；§4.1 举例列 3 个 hook | 实际注入 **6 个**：`beforeToolCall`(101) / `afterToolCall`(102) / `shouldStopAfterTurn`(103) / `getSteeringMessages`(104) / `transformContext`(88) / `prepareNextTurn`(110) | ⚠️ 宪法漏记 2 个（steering、compaction 的契约从未回写） |
| Rule 5.1 low/medium/high 分级 | `should-stop-after-turn.ts:114-188` 逐级实现，与宪法逐字对应 | ✅ 一致（本仓执行得最好的一条） |
| Rule 5.2 §2 "undo journal (backup file before write/edit)" | `before-tool-call.ts:46-52` 调 `journalFile()`，但 `journal.ts:26` 读 `FORGE_UNDO_DIR`，**生产无任何地方设置它** → `journal.ts:48` 立即 `return null` | ❌ 声明存在，实现空转 |
| Rule 5.2 §1 "Guard policy" | 步骤存在，但 `before-tool-call.ts:31` 是 `loadPolicy()`（无参）→ `policy.ts:127` 直接返回内置默认，**用户策略文件不参与决策** | ⚠️ 半实现 |
| Rule 5.3 列 **4 种** stuck 模式 | `stuck-detector.ts` 实现 3 种；`monologue` 阈值(`:12`) 定义后**无任何代码使用**。宪法说 afterToolCall + shouldStopAfterTurn 共同检测，`shouldStopAfterTurn` 内无任何 stuck 逻辑 | ❌ 1 种缺失 + 检测点描述不实 |
| Rule 5.4 cost budget | `should-stop-after-turn.ts:96-101` `isExhausted()` + 写 `failureReason` | ✅ |
| Rule 5.5 三种错误恢复（truncated / **empty** / API error，各 max 3） | truncated ✅ `:78-89`；API error ✅ `:60-76`；empty —— `:91-93` 算出 `isEmpty` 后**从未使用**（死变量） | ❌ 空响应不重试 |
| Rule 5.6 缓存稳定 4 条（工具排序 / system prompt 分段 / sticky latch / 非 Anthropic 跳过） | `transform-context.ts` 全文只做"字符数估算 + 保留最近 20 条"，4 条均无 | ❌ 整条未实现 |
| Rule 6.2 验证命令白名单 | `command-policy.ts:11-17` + READ_ONLY_BINARIES `:29-31` | ✅ |
| Rule 7.2 FIFO 事件追加 | `event-log.ts:117-144` per-session promise 链 | ✅ |
| Rule 7.3 EventBus fan-out，"subscriber count today is zero" | `event-log.ts:165-167` fan-out；全仓无 `defaultBus.subscribe` 调用 | ✅ 诚实且准确 |
| Rule 8.1 崩溃恢复三要素含 "undo journal has file backups" | session.json ✅、events.jsonl ✅、journal.jsonl ❌（P0-1） | ⚠️ 三缺一 |
| Rule 9.1 "没有 UI 入口的能力对用户不存在" | 该条被自己违反 5 次（见 §2 P1-6） | ❌ |
| Rule 9.2 表：Undo journal → Diff panel + Undo button | `SessionView.tsx:284-289, 387-401` 按钮与面板都在，但后端无数据 | ⚠️ UI 说谎 |
| §11 "Avoid: state in guardrails" | `StuckDetector` 持 history；`shouldStopAfterTurn` 持 turnCount/recoveryCounts/verificationRound | ⚠️ 可接受的实用偏离，但宪法未同步 |
| §12 "Branch discipline: `main` is always releasable" | 分支已迁 `master`（main 停在 69d7cd0） | ⚠️ 文档过期 |

**判断**：宪法正在从"约束"退化为"愿景文档"。写了 3 条代码没有的、漏了 2 个代码有的。既然本项目的红线是"文档不是事实"，建议给每条 Rule 补一个 `实现位置 file:line` 字段，让 Rule 可以被机械核对——否则下一次漂移同样不会被发现。

---

## 2. 架构偏移清单

### P0-1 ｜ Undo journal 在生产中永不写入（同时废掉 Diff / Undo / 免审批理由）

**证据链**

1. `before-tool-call.ts:51` — `await journalFile(config.workspace, input.path)`
2. `journal.ts:25-27` — `undoDir()` → `process.env.FORGE_UNDO_DIR ?? null`；`:48` `if (!dir) return null`（静默）
3. 全仓搜 `FORGE_UNDO_DIR`：仅 `journal.ts`（读）与 `undo.test.ts:26`（测试设置）。**生产代码零设置点。**
4. `desktop/src-tauri/src/lib.rs:79-86` — sidecar spawn env 只有 `FORGE_HOME` / `FORGE_RUNTIME`
5. 成因取证：`git show 49f1fda` 第 10898 行 `-        FORGE_UNDO_DIR: join(this.forgeHome, "undo", opts.taskId),` —— 那行原属被删除的 `pi-adapter.ts`（spawn Pi 子进程时注入）
6. 连带：`captureGitHead`（`undo.ts:47`）**只被自己的测试调用** → `readGitHead` 永返回 null → `computeDiff` 的 `kind:"git"` 分支在产线不可达

**用户可见后果**

- 写前备份从不发生 → agent 改坏文件无回退点
- `POST /sessions/:id/undo` → `restoreUndo` 读空 journal → 恢复 0 个文件
- `GET /sessions/:id/diff` → 永远 `{kind:"none", reason:"no tracked changes"}` → 前端显示 `(no changes)`
- **安全含义**：`policy.ts:105-108` 把 write/edit 设为免审批，理由原文是"File writes are covered by the undo journal (restorable)"。该理由在生产中不成立——**写操作既不需要批准，也没有备份。**

**这不是漏接线，是范式冲突**：in-process 是单进程多会话，`FORGE_UNDO_DIR` 是进程级全局变量，**结构上无法承载 per-session 值**。同理 `guard/index.ts` 那条"扩展入口"路径也是子进程时代的产物。修法应当是把这个值变成显式参数（`journalFile(undoRoot, cwd, relPath)`），而不是在 `launchAgent` 前后 set/unset env（那是竞态）。

### P0-2 ｜ 用户 guard.json 不生效 + "Always allow" 链路整体消失

**证据链**

1. `before-tool-call.ts:31` — `evaluateToolCall(loadPolicy(), toolName, input)`
2. `policy.ts:126-127` — `loadPolicy(path?)`：`if (!path) return defaultPolicy();` → **无参即内置默认**
3. 唯一读用户策略的地方是 `verification/command-policy.ts:78`（`loadPolicy(defaultPolicyPath())`）—— 即"验证命令"读用户策略，"工具调用"不读，同一份策略两种待遇
4. `appendRule`(`policy.ts:158`) / `ruleFromApproval`(`:190`) / `summarizeInput`(`:269`) 除 `guard/index.ts`（死 barrel）与测试外**无调用者**
5. `http-server.ts` 无任何 "always" 路由；`ApprovalDialog.tsx:36-43` 只有 Deny / Approve
6. 成因取证：`git show 49f1fda` 第 8378 行 `-    makeGuardHandler(loadPolicy(defaultPolicyPath()))(event, ctx),`

**判断**：任务 #23/#24（appendRule + "Always allow" 按钮）在 Phase 1 被整体删除，但**只删了调用点和 UI，没删后端实现**，于是留下一组"看起来有、实际没人调"的孤儿 API。`policy.ts:92` 的注释仍宣称 "User-overridable via ~/.forge/guard.json (FORGE_GUARD_POLICY)" —— 不实。

### P0-3 ｜ 侧栏项目切换静默失效（又一个"UI 说谎"）

**证据链**

1. `Sidebar.tsx:81, 92` — `await selectProject(id)`
2. `api.ts:168-170` — `send("/projects/select", "POST", { id })`
3. `http-server.ts:271-285` — **只有** `POST /projects`（register）与 `GET /projects`。`/projects/select` 无路由 → 落到 `:287` 的 404
4. `Sidebar.tsx:82` — `catch { /* registry keeps prior state on failure */ }` → **静默吞掉**
5. `ProjectsRegistry.select`（`projects.ts:99-110`，实现是对的）只有 `real-smoke.ts:50` / `real-compact-smoke.ts:31` 调
6. 追加缺陷：`App.tsx:56` `activeProjectId = activeSession?.projectId` → `Composer.tsx:65` 把**当前会话的项目**当作新会话的项目。**即使补上路由，侧栏选择也不影响新会话。**

**后果**：新会话的 workspace 由"上一个注册的项目"或"当前会话的项目"决定，与侧栏显示的下拉值无关。与刚修掉的"回车没反应"属于同一类故障：**UI 状态与后端状态脱钩，且失败被 catch 吞掉不告诉用户。**

### P1-4 ｜ 会话状态文案两套（i18n 不一致）

`Sidebar.tsx:14-19` 有中文 `statusLabel`；`SessionView.tsx:263` 直接渲染裸 `{status}`（`running` / `completed` / `failed`）。同屏两套语言。`trustLabel` / `thinkingLabel` 都已抽到 `lib/`，唯独 status 没有——照同样的做法补 `lib/status.ts` 即可。

### P1-5 ｜ 同名模型的多个订阅无法区分，且守卫比较了错误的命名空间

- `SessionView.tsx:153-154`：`activeProviderId = providers.find(p => p.modelId === effectiveModelId)?.id` → 两个订阅都用 `gpt-5` 时永远命中第一个 → picker 高亮错订阅、`thinkingLevels` 取错模型的能力集
- `SessionView.tsx:196`：`if (!providerId || providerId === effectiveModelId) return;` → 拿 **provider id** 与 **model id** 比较，是命名空间错配的 no-op 守卫
- 修法：`Session.model.provider` 服务端已经存了正确的 provider id，直接用它

### P1-6 ｜ "没有 UI 入口的能力 = 不存在"被自己违反 5 次

| 能力 | 后端 | UI 入口 |
|---|---|---|
| Undo / Diff | 有端点，无数据（P0-1） | 按钮在，点完是 `(no changes)` / 恢复 0 |
| cost budget | `POST /sessions` 收 `maxCost`；CostGuard 生效 | **Composer 不传** → 永远 null → CostGauge 永远无上限 |
| turn budget（maxTurns） | schema v5 专门迁移、CompletionConfig 携带、`:102` 生效 | **Composer 不传** → 永远 null → 该护栏对用户不存在 |
| 厂商预设 `PROVIDER_PRESETS`（8 家） | `config-store.ts:51-60` | 只有 `config-store.test.ts` 用。Settings 页 `:150-155` 硬编码一条 openai-completions 模板 |
| "Always allow" | `appendRule` 等 | 无按钮、无路由（P0-2） |

`schema.ts:44-46` 的注释写"turn budget was previously only carried in the in-memory CompletionConfig — a resumed session lost it"，为此升到 v5；但**今天没有任何 UI 能设置它**，所以这层迁移保护的是一个恒为 null 的字段。（任务 #84 标 pending，状态与实际不符。）

### P2-7 ｜ 事件类型双定义（漂移风险）

`events/event-types.ts:15-33`（`ControlEventType`，15 个）与 `core/persistence/event-log.ts:78-94`（`CONTROL_EVENT_TYPES` 集合，15 个）是**同一份清单抄两遍**，靠 `event-log.ts:166` 的 `bus.publish(event as ControlEvent)` 强制转换粘住。任何一边加减类型，另一边不会报错。让类型从集合派生（或集合从类型派生）即可消除。

### P2-8 ｜ `taskId` 词汇贯穿全仓，但域模型早已是 Session

`PersistedEvent.taskId` / `ControlEvent.taskId` / `EventEnvelope.taskId` / `TaskEventStream(taskId)` / `undo(forgeHome, taskId, ...)` / `EvaluationResult.taskId` / `TaskOutcome` / `notifyTaskOutcome`。命名债，不影响正确性，但每次读代码都要在脑内做一次 task↔session 翻译。

### P2-9 ｜ 其他重复与残留

- `fetchConfig` 三份（`SettingsPage:13` / `Composer:42` / `SessionView:164`）；`modelCapabilities` + `thinkingLevels` 推导两份（`Composer:51` / `SessionView:156`）
- 协议清单三份：`config-store.ts:16 PROVIDER_APIS` / `SettingsPage.tsx:5 PROTOCOLS` / desktop `types.ts:31 ProviderApi`
- desktop `types.ts:1` 自承认 "Mirror of the server-side Session model — keep in sync"（`desktop↔server` 是真边界，手抄可接受，但应有一致性断言测试）
- `should-stop-after-turn.ts:122-129` 嵌套三元两支都返回 `[]`（死逻辑，等价于 `const checks = criteria`）
- `App.tsx:37` 与 `:39` 重复调用 `refreshSessions()`
- `store.ts:363-369` 判 `payload.kind === "guard_approval_request"`：服务端从不这样发（它发独立类型 `GUARD_APPROVAL_REQUEST`）→ 死分支；审批实际完全依赖 `:485` 的 2.5s 轮询
- `session-manager.ts:50` `idle` map **只写(:519)不读** → 死状态 + 无界增长；`ActiveEntry.sessionId`(`:27`) 同样只写不读
- `approval-hub.ts` 的 `records` / `byTask` 永不清理 → 长跑进程无界增长
- `serve.ts:3` 与 `:15` 重复 `import node:path`（`:15` 那行出现在使用点之后——ESM 提升所以能跑，但读起来像 bug）
- `model-resolver.ts:17-33` `lookupBuiltinModel` 每次调用全目录线性扫两遍；`GET /config` 对**每个订阅**调一次 `buildModel` → O(订阅 × 目录)，属于每次开面板都白付的成本
- `model-resolver.ts:100-102` `makeStreamFnWithKey` 写 `process.env`（全局副作用，多订阅不同 key 时首个胜出）
- `json.ts:5-7` `TASKS_DIR` 是**模块加载期读 env**——正是本次在 `session-store.ts` 修掉的那个反模式；此处因该常量已死而无害，但留着就是下一颗雷
- `json.ts:21` 函数内 `await import("node:fs/promises")` 动态导入内置模块（无意义）
- `should-stop-after-turn.ts:99,104` 对已内部 catch 的 `recordVerification` 再 `.catch(()=>{})`（双重）
- desktop `types.ts:44` `defaultProviderId: string`，服务端可为 `null`
- `tsconfig.json` 的 `exclude` 单列 `src/cli/benchmark.ts` → 该文件**不被 `npm run typecheck` 覆盖**，只由不在门禁里的 `typecheck:bench` 覆盖

---

## 3. 死代码清单

### A 级 — 整目录（零引用）

| 路径 | 体量 | 说明 |
|---|---|---|
| `ui/` | 16 个 tracked 文件 + 磁盘上还有 `dist/`、`node_modules/`、`package-lock.json` | 上一代前端：`PlanView.tsx`、`RuntimeDetail.tsx`、`TaskHeader.tsx`、`TimelineView.tsx`、`MemoryPanel.tsx`、`VerificationPanel.tsx`、`useUiStore.ts`、`eventClient.ts`。Plan/Step 时代的遗物，被 `desktop/` 取代。全仓零引用。 |
| `benchmark/`（仓库根） | 7 文件 800 行 | 被 `src/benchmark/`（517 行）取代；全仓零引用（`src/cli/benchmark.ts:5-6` 引的是 `src/benchmark/`）。`tsconfig.benchmark.json` 仍 include 它，而 `npm run typecheck:bench` 不在 release-check 里 → 连类型检查都不会跑。 |

### B 级 — 整文件

| 文件 | 行数 | 可达性 |
|---|---|---|
| `src/guard/index.ts` | 18 | 零引用 barrel（仅 `docs/17-GUARD-POLICY.md:5` 提到，且该文档描述的 `GUARD_ENTRY_PATH` 机制已不存在） |
| `src/evaluation/index.ts` | 9 | 零引用 barrel |
| `src/core/types/index.ts` | 7 | 零引用 barrel（`criterion.ts` / `evaluation.ts` 都被直接 import） |
| `src/verification/index.ts` | 4 | 仅 `verify.test.ts` 引用 |
| `src/verification/engine.ts` | 40 | 仅测试可达；`verifyCriteria` 带废弃参数 `stepId`（`:5,14,28`），产线已被 `guardrails/should-stop-after-turn.ts` 逐条 `validate()` 取代 |
| `src/cli/real-smoke.ts` / `real-compact-smoke.ts` | 111 / 76 | 手工脚本（需真 key），不在门禁。**留存合理，但应在文件头或 docs 标注 manual-only** |

### C 级 — 符号级零调用

- `server/auth.ts`：`readHandshake`(:33)、`removeHandshake`(:29)
- `server/config-store.ts`：`isConfigured`(:142)、`maxConcurrency`(:66,73,103,115,126 —— 解析并持久化但无人消费，task-manager 时代的并发上限)、`PROVIDER_PRESETS`(:51-60，仅测试)、`newProviderId`(:76，仅 `validateProvider` 内部用)
- `server/event-stream.ts`：`isClosed`(:42)
- `server/approval-hub.ts`：`get`(:47，仅测试)
- `server/projects.ts`：`get`(:112)、`active`(:117)（零调用）；`select`(:99) 仅 smoke 脚本
- `guard/policy.ts`：`summarizeInput`(:269)、`ruleFromApproval`(:190)、`appendRule`(:158)
- `core/persistence/json.ts`：`taskPath`(:25)
- `desktop/src/types.ts`：`StuckWarningView`(:104)、`ToolCallView`(:81)
- `desktop/src/lib/store.ts`：`resetConversation`(:49,594)、`useDesktopStore`(:598)；`api.fetchSession`(:69)；`api.createSession` 的 `maxCost`(:59)（store 层已无该字段，Composer 不传）

### D 级 — 配置/脚本

- `package.json`：`start` → `dist/cli/run.js`、`demo` → `src/cli/run.ts`，**两者都已不存在**；`build` → `tsc -p tsconfig.json`，而该 tsconfig 是 `noEmit: true` → **build 不产出任何东西**；`clean` 无所指
- 实际运行路径与以上全无关系：`lib.rs:79-80` 用 `node --import tsx/esm src/cli/serve.ts` 直接跑源码 → `dist/` 不在链路里
- `tsconfig.benchmark.json` 指向死目录 `benchmark/`
- `.audit-imports.mjs`（本次审视新建，未跟踪）

---

## 4. 测试与门禁缺口

| 缺口 | 说明 |
|---|---|
| **桌面端零自动化测试** | `reduceEnvelope`（`store.ts:122`）是纯函数，`__replay.ts` 里有真实捕获帧，两者都齐了，却没有一个断言进 release-check。会话流顺序这类最易出错的逻辑目前只能靠人眼看 `preview.html?scene=replay`。这是当前最大的质量缺口。 |
| **门禁不覆盖 Rust** | `release-check.sh` 21→23 项全在 TS 侧；`cargo check` / `tauri build` 不在门禁（上次删 Tauri 命令是我手工 `cargo check` 验证的） |
| **门禁不检测死代码** | 没有 knip / ts-prune 类检查 → `ui/`、`benchmark/`、三个死 barrel 能长期存活 |
| **smoke 不覆盖 undo 回退** | 全部 smoke 只设 `FORGE_EVENTS_DIR` / `FORGE_SESSIONS_DIR`，**没有一个设 `FORGE_UNDO_DIR`** → P0-1 这类"环境变量没接线"的故障结构上抓不到。这与上次 `FORGE_SESSIONS_DIR` 惰性求值的问题是同一类：*测试自己搭好了环境，于是永远发现不了生产没搭*。 |
| 门禁不跑 `src/cli/benchmark.ts` 类型检查 | 见 P2-9 末条 |
| 无一致性测试 | desktop 手抄的 `types.ts` / `PROTOCOLS` 与服务端无断言约束 |

---

## 5. 架构是否合理：判断

### 合理的部分（建议保持，不要动）

1. **进程内单循环 + 6 个 hook**：`agent-runner.ts` 168 行纯函数，把 guardrail 作为回调注入 Pi，没有复活状态机。这是本次宪法更替最成功的一步。
2. **`should-stop-after-turn.ts`**：分层次序（错误恢复 → 硬停止 → 模型还在工作 → 按 trust 验证）逻辑清晰，`low/medium/high` 与宪法逐字对应，`terminate` 时主动写 `session.failureReason`（`:73,98,103`）以区分"预算耗尽"与"正常完成"——这个细节说明作者真的想过 settle 路径。
3. **事件日志三件套**（FIFO 追加 + SSE 重放跟随 + replay 重建）：FIFO 的注释把"libuv 线程池竞态导致 CJK 乱序"的根因写清楚了，是仓库里最扎实的一段。SSE 无 `Last-Event-ID` 所以客户端用 `seq` 水位线去重（`store.ts:471-475`），取舍说明白。
4. **compaction**（`compaction.ts` 305 行）：优先 Pi 的 LLM 摘要、失败降级截断、`estimateContextTokens` 修正 `tokensBefore`、runtime 切换检查前置到阈值早退之前（`:143-167` 的注释解释了"否则切换看起来是坏的"）——这些都是踩过坑才写得出来的。
5. **schema.ts 迁移的克制**：v5→v6 把旧会话迁到 `thinkingLevel:"off"` 而不是新会话默认值，理由是"migration must not silently change how a stored session behaves"（`:56`）。这个判断是对的。

### 不合理 / 需要纠正的部分

1. **范式迁移的成本没有清点。** Phase 1 把"每会话一子进程"改成"进程内共享"，但所有原本靠 per-task env 或每进程一次性设置的东西（`FORGE_UNDO_DIR`、guard 扩展入口、`maxConcurrency`）都变成了**没有承载者**。这不是三个孤立 bug，是**一类**。建议做一次系统性清理：把所有 per-session 运行时配置从 env / 全局 map 改成**显式参数**，并把 `active` / `idle` / `pendingModels` / `pendingThinking` / `completions` 五个 per-session map 收敛成一个 `SessionRuntime` 对象（顺带解决 `idle` 泄漏和"同一个 sessionId 在 5 个 map 里各存一份"的隐式不变量）。
2. **宪法与代码双向漂移**（§1 表）。建议给 Rule 加 `实现位置` 字段。宪法只在"能被机械核对"时才有约束力。
3. **Rule 9.1（没有 UI 入口的能力不存在）没有被当成验收门禁**，结果是 5 处违反（§2 P1-6）。建议把 Rule 9.2 的表变成 PR checklist。
4. **仓库卫生影响开源可信度。** 外部评审上一次因为 `/pi/` 被 gitignore 而误判架构；现在 `ui/` + `benchmark/` 两个死目录 + 失效的 `package.json` 脚本会给出"项目没维护"的信号。
5. **桌面端没有测试**，而桌面端恰好承载了最微妙的逻辑（SSE 折叠、id 去重、时间线顺序）。

---

## 6. 建议的修复顺序

**P0（建议本轮，都是小改动 + 高收益）**

1. `before-tool-call.ts:31` → `loadPolicy(defaultPolicyPath())`（一行，救回用户策略）
2. undo 接线：`journalFile` / `journalPath` 改收 `undoRoot` 参数；`SessionManager.launchAgent` 前把 `<forgeHome>/undo/<sessionId>` 传进 `GuardrailConfig`；同时补 `captureGitHead` 的调用点（或在 `computeDiff` 里改为"与 session 创建时刻的 HEAD 比对"）
3. 侧栏项目切换：补 `POST /projects/select` 路由 + `App.tsx:56` 改为用侧栏的 `activeProjectId`
4. 三个 D 级配置：修 `package.json` 的 `start`/`demo`（或直接删），明确 `build` 的去留

**P1**

5. 宪法回写：删/改 Rule 5.3 的 `monologue`、Rule 5.5 的 empty、Rule 5.6 的缓存 4 条（要么实现、要么从宪法删除）；补 `getSteeringMessages` / `prepareNextTurn` 的契约；给每条 Rule 加实现位置
6. 删 `ui/` 与 `benchmark/`（以及 `tsconfig.benchmark.json` 的 include 项）
7. 补齐 `maxTurns` / `maxCost` 的 UI 入口，或从宪法/API 里删掉——不要保留"后端有、UI 无"的中间状态
8. 恢复或删除 "Always allow"（含 `appendRule` / `ruleFromApproval` / `summarizeInput` / 死 barrel）

**P2**

9. 桌面测试进 release-check：把 `__replay.ts` 的帧喂进 `reduceEnvelope`，断言时间线形状与 id 幂等（这是最高性价比的一项）
10. 死符号清理（§3 C 级）+ 死逻辑清理（`isEmpty`、`checks` 三元、`STEERING_QUEUED` 的 kind 分支、`idle`）
11. 命名收敛 `taskId` → `sessionId`；事件类型单一来源；`statusLabel` 抽到 `lib/status.ts`
12. 门禁加 `cargo check` 与死代码检查（ts-prune / knip）
13. `lookupBuiltinModel` 记忆化（`GET /config` 每次全目录扫两遍）

---

## 7. 本次审视的覆盖范围（诚实声明）

**逐行读过**：`src/` 全部 20 个非测试源文件（agent-runner / types / events×3 / core/persistence×5 / core/types×3 / server×9 / guardrails×8 / guard×3 / verification×5 / evaluation×3）；`desktop/src/` 全部 18 个文件（含 1313 行的 `__replay.ts` 抽查结构、404 行 `preview.tsx` 抽查）；`scripts/`×3、`package.json`、`tsconfig.json`、`tsconfig.benchmark.json`、`AGENTS.md` 全文。

**未逐行读**：`pi/`（vendored，328k 行）——只审了 Forge 与 Pi 的接缝（`agentLoop` 调用签名、`AgentLoopConfig` 6 个 hook、`prepareCompaction`/`compact` 的 shim）；`src/cli/` 的 6 个 smoke 脚本（本会话只核了它们的 env 设置与门禁状态，未重读逐行）；`desktop/src/styles.css`（未审视觉）；`.github/`。

**未验证的推断**（若要用作决策依据需先取证）：
- `npm run build` 不产出（由 `tsconfig.json` 的 `noEmit: true` 推出，未实跑）
- `ui/` 与 `benchmark/` 在 git 历史中的最后使用时间（未查 `git log --diff-filter=D`）
- 打包分发（`tauri build`）目前是否真的可用——`lib.rs:20-30` 的注释承认需要显式设 `FORGE_ROOT`，我未实测
