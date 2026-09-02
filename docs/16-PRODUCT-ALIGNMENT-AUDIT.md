# Product Alignment Audit — 首屏 / Project / Model / In-Place

> Date: 2026-08-30
> Author: Forge 首席开发者 → 产品经理
> 性质：只读审计，未改任何代码。
> 依据：产品经理 2026-08-30 十二条产品原则 + 验收标准 16 条。
> 范围：src/（77 文件）、desktop/src（14 文件 980 行）、ui/src（11 文件）、docs/01–15。
> 关联：docs/15（Amendment A-2 已提案，本审计在其基础上收敛实施顺序）。

---

# 1. 现状盘点（9.x 实际交付了什么）

以代码为准（docs/14 的 P9 清单大部分未做，不能引用文档结论）：

| 已交付 | 证据 |
|---|---|
| Desktop 扩展为 5 页 Shell（Tasks/Projects/Settings/Sidebar/Wizard/ErrorCenter） | desktop/src 14 文件 980 行 |
| Provider 配置存取：`~/.forge/forge-config.json` + `GET/PUT /config` | config-store.ts, http-server.ts:252–276 |
| Provider readiness 检查 `POST /config/test`（api_auth → basic_completion → tool_calling → structured_plan，含真实 Pi 会话） | provider-check.ts, runtime-readiness.ts |
| Tauri 注入 `window.__FORGE_CONFIG__`（docs/14 所述"从未注入"已过时） | src-tauri/lib.rs:124–131 |
| Projects 注册/选择 API（`~/.forge/projects.json`） | projects.ts |
| 错误归集组件（TaskDetail 内嵌 Issues 面板） | ErrorCenter.tsx |
| 本地发布校验脚本（typecheck + tests + seam + bench + 7 demos） | scripts/release-check.sh |

| 未交付（docs/14 P9 清单核对） | 证据 |
|---|---|
| P9-2 fallback plan 仍引用 hello.txt + "wrong-content" | llm-planner.ts:88 |
| P9-3 任务创建前无 preflight（`/config/test` 存在但没接到 POST /tasks） | task-manager.ts:96–137 |
| P9-4 `checkStepAttempts()` 定义未调用（step 级重试上限失效） | retry-policy.ts:16，全仓库无调用点 |
| P9-5 CI：仓库不是 git 仓库，无 CI | git rev-parse 失败 |
| Task 创建入口（Desktop 无任何 POST /tasks 调用方） | grep 全 desktop/src 无匹配 |
| SSE 接线（`connectStream` 定义未调用，Timeline 永远 "connecting…"） | useDesktopStore.ts:44 |

---

# 2. 冲突清单（现状 vs 十二条产品原则）

## 原则一：首屏（冲突最严重）

| # | 现状 | 冲突点 | 归属 |
|---|---|---|---|
| C1 | `App.tsx:64–71`：启动时 `getConfig()` 判定 `configured`；`provider === null` → 整个 App 被 `<Wizard>` 替换 | 配置向导 = 启动门槛，违反"打开即主 Shell" | 9.6.7 |
| C2 | `Wizard.tsx` 首屏即 Provider/API Key/Test Connection/Enter Forge | 是配置向导，不是"可关闭轻量提示"（虽有 Skip 链接，但它就是首屏） | 9.6.7 |
| C3 | `App.tsx:49` `localStorage["forge-has-launched"]` 一旦置位就跳过配置检查 | 用 localStorage 冒充配置状态，配置被删后 UI 与后端状态脱节 | 9.6.7 |
| C4 | 无 Model 时主界面可以进（localStorage 路径），但无任何"运行时才检查 readiness"的机制——因为根本没有运行任务的入口 | 原则 6/9 目前无从谈起 | 9.6.2 + 9.6.7 |

## 原则二：Project 模型

| # | 现状 | 冲突点 | 归属 |
|---|---|---|---|
| C5 | `activeProject` 仅存在于 projects.json 与 UI 徽章；任务执行目录恒为 `~/.forge/tasks/<taskId>`（pi-adapter.ts:22 ensureTaskDir） | `activeProject → Task → workspaceRoot` 链路不存在，Project 是纯装饰 | 9.6.2 |
| C6 | ProjectsPage 加项目 = 手工输入绝对路径文本框 | 违反 docs/12 §2.1 自己定的"never typed paths"；Tauri folder dialog 未接 | 9.6.7 |
| C7 | `config.workspace` 字段全仓库无消费者 | 死字段，语义与 Project 重叠，易误导 | 9.6.3 |

## 原则三：Model 模型

| # | 现状 | 冲突点 | 归属 |
|---|---|---|---|
| C8 | `serve.ts:29–30` 硬编码默认 `anthropic` / `claude-opus-4-8`；无配置时静默走环境变量 | 无配置任务不会在创建时失败，而是 Pi prompt 失败 → fallback plan（wrong-content）→ FIX 预算烧尽 → FAILED，错误原因对用户不可见 | 9.6.2（preflight 接入） |
| C9 | Task model override：`POST /tasks` 已接受 `provider/modelId` 参数（task-manager.ts:104–105） | API 层已就绪，UI 无入口 | 9.6.7 |
| C10 | SettingsPage 内嵌 workspace 输入框 | 与 C7 同源，UI 层死字段 | 9.6.3/9.6.7 |

## 原则四：Task Creation

| # | 现状 | 冲突点 | 归属 |
|---|---|---|---|
| C11 | **Desktop 无法创建任务**。TasksPage 只有搜索框；全前端无 `POST /tasks` | 验收标准 7（"可以直接输入 Task"）当前为 0 分；这是最大的单点缺口 | 9.6.7（依赖 9.6.2 的 workspace 绑定，否则创建即跑空沙箱） |

## 原则六/九：就地执行 + Undo

| # | 现状 | 冲突点 | 归属 |
|---|---|---|---|
| C12 | `PiRuntime.createSession` 派生 `~/.forge/tasks/<taskId>`；`destroy()` 对该目录 `rm -rf` | shadow 目录是当前唯一模式；且 destroy 会删目录（见 §3 专章） | 9.6.1 |
| C13 | `FakeRuntime` 同样派生子目录且 destroy `rm -rf`（fake-runtime.ts:34–36, 66） | 与 C12 同源，seam 语义必须一起改 | 9.6.1 |
| C14 | 无 Undo Journal、无 Diff 展示；就地执行后这是唯一的安全网（git 非必选） | 缺失 | 9.6.6 |

## 原则七/八：Tool Permission + 审批

| # | 现状 | 冲突点 | 归属 |
|---|---|---|---|
| C15 | 完全缺失。Pi 侧能力已核实可用（agent-loop.ts:636 block/terminate；rpc-types.ts:281 extension_ui_response；args.ts:157 `--extension`） | 无冲突，纯待建。注意：产品要求 capability 模型（read/write/edit/bash/delete/network/git/destructive 八类），docs/15 的三档策略需按 capability 扩展 schema，默认策略另行设计（待 PM 确认） | 9.6.4 |
| C16 | 无审批 UI。审批归属 Tool Runtime 层，不动状态机——与 docs/15 §4.2 一致 | 缺失 | 9.6.5 |

---

# 3. destroy() 的 rm -rf 风险专章（审计项 D）

**结论：风险确认，且比 docs/15 初稿写的更广——共有 2 个生产删除点、3 个触发调用点。**

## 3.1 删除点（生产代码，共 2 处）

| 位置 | 代码 |
|---|---|
| `src/runtime/pi/pi-adapter.ts:77` | `await rm(pi.directory, { recursive: true, force: true })` |
| `src/runtime/fake-runtime.ts:66` | `await rm(session.directory, { recursive: true, force: true })` |

其余全仓库 `rm(recursive)` 均在 demos/tests（TMP 目录）与 `task-store.ts:42`（删任务 JSON 记录，不碰工作区）——无需处理。

## 3.2 触发调用点（生产代码，共 3 处）

| 调用点 | 场景 | 就地执行后的后果 |
|---|---|---|
| `task-manager.ts:211`（cancel） | 用户在 Desktop 点停止，或侧车关闭清理 | **删除用户整个项目目录**。这不是理论风险：cancel 是验收标准里的常规操作 |
| `runtime-readiness.ts:122`（finally 清理） | Settings 里每次 "Run Readiness Check" | readiness 目前以 `forgeHome` 为 workspaceRoot 写 marker 文件；语义变更后若直接指向用户目录，同样命中删除 |
| `cli/run.ts:208` | CLI demo 收尾 | demo 路径，低风险，但语义需一致 |

## 3.3 触发链

```
Desktop 取消任务
  → POST /tasks/:id/cancel
  → TaskManager.cancel → rec.runtime.abort → rec.runtime.destroy   (task-manager.ts:207–212)
  → PiRuntime.destroy → client.close() + rm -rf(session.directory)  (pi-adapter.ts:74–78)
  → 用户项目目录被删除
```

当前不炸的唯一原因是：session.directory 是 `~/.forge/tasks/<taskId>` 沙箱而非用户目录。**A-2 落地瞬间该行为变成数据删除事故**——所以 9.6.1 必须先于 9.6.2，这是正确顺序。

---

# 4. 最小修改计划（审计项 C，总览）

与 PM 指定的 9.6.1–9.6.7 顺序一致，逐条对齐冲突编号：

| 步骤 | 目标 | 解决的冲突 | 主要文件 |
|---|---|---|---|
| 9.6.1 | destroy 红线修复 + workspace 语义（精确目录，不派生） | C12, C13 | interface.ts, pi-adapter.ts, fake-runtime.ts, engine.ts, runtime-readiness.ts, seam-test.ts |
| 9.6.2 | activeProject → workspaceRoot 正式绑定 + 任务创建 preflight | C5, C8, C4 | task-manager.ts, engine.ts, projects.ts, http-server.ts |
| 9.6.3 | Schema v3：workspacePath/projectId 入 TaskSession；清死字段 config.workspace | C7, C10 | task-session.ts, schema.ts, task-store.ts, config-store.ts |
| 9.6.4 | Guard Extension：capability 模型（8 类）allow/deny/ask + policy schema | C15 | 新增 src/guard/，pi-process.ts（--extension） |
| 9.6.5 | Desktop 审批 UI（approve 卡片，走 extension_ui_request/response） | C16 | desktop/src 新 ApprovalCard + server 转发 |
| 9.6.6 | Diff + Undo Journal（写前备份，git 可选） | C14 | 新增 journal 模块 + GET /tasks/:id/diff + POST /tasks/:id/undo |
| 9.6.7 | 首屏纠偏：去 Wizard 门槛、New Task 入口、原生 folder dialog、运行时 inline error/CTA | C1, C2, C3, C6, C9, C11 | App.tsx, Wizard.tsx→Welcome, TasksPage.tsx, ProjectsPage.tsx |

依赖关系：9.6.2 依赖 9.6.1 的语义；9.6.3 的 workspacePath 由 9.6.2 填充；9.6.7 的 New Task 依赖 9.6.2（否则创建任务没有 workspace 可用）。

---

# 5. 9.6.1 具体修改范围（本阶段唯一实施项）

**目标**：workspace 语义改为"精确目录"，并根除 destroy 对工作目录的删除。此步完成前，9.6.2 不开工。

## 5.1 文件级修改清单

### ① `src/runtime/interface.ts`
- `CreateSessionOptions.workspaceRoot` 重命名为 `workspace`。
- 注释改为：**"Exact working directory for the session. The adapter MUST use it as-is and MUST NOT derive or append a subdirectory. The caller owns creation and lifecycle of this directory."**

### ② `src/runtime/pi/pi-adapter.ts`
- `createSession`：
  - 删除 `ensureTaskDir()` 调用与函数（或将其移入 readiness，见 ④）。
  - `directory = resolve(opts.workspace)`。
  - 保留一次幂等 `mkdir -p`（目录已存在时 no-op；为 shadow 兼容路径与 readiness 沙箱兜底），**禁止**拼接 taskId。
- `destroy`：
  - **删除 `rm(pi.directory, ...)` 整行**。只保留 `client.close()`（杀进程）。
  - 函数注释加红线说明：destroy 只负责进程生命周期，永不负责文件系统生命周期。

### ③ `src/runtime/fake-runtime.ts`
- `createSession`：`directory = resolve(opts.workspace)`，删除 taskId 拼接。
- `destroy`：删除 `rm(session.directory)`，只留 `destroyCalls++` 计数。
- （测试基建依赖它的地方走 engine 的 fallback 路径，见 ⑤，行为不变。）

### ④ `src/server/runtime-readiness.ts`
- `workspaceRoot: opts.forgeHome` → `workspaceRoot: join(opts.forgeHome, "readiness", taskId)`。
- 理由：readiness 会让 agent 写 marker 文件并执行 bash；语义变更后不能把 forgeHome 根当工作区。专用沙箱 + finally 里由 readiness 自己清理（保留现有 destroy 调用即可，destroy 已不再删目录；目录清理改为 readiness 侧显式 `rm` 该 readiness 专用子目录——它是 Forge 自建目录，不是用户数据）。

### ⑤ `src/orchestrator/engine.ts`（仅 ensureSession，一处）
- `workspaceRoot: FORGE_HOME` → `workspace: task.directory?.trim() ? resolve(task.directory) : join(FORGE_HOME, "tasks", task.id)`。
- fallback 分支保持旧 shadow 行为：v2 schema 下 `task.directory` 为空（新任务）或已有值（恢复任务），现有 demos/基准全部继续工作。9.6.2 接入 project 后，此处自然变为项目目录，**不再改 engine**。

### ⑥ `src/runtime/seam-test.ts`（新增红线断言，本步的验收核心）
新增两条断言：
1. **精确目录**：预置目录 `X`（含一个文件）→ `createSession({workspace: X})` → `session.directory === X`（无子目录拼接）。
2. **destroy 不删数据**：对上述 session 执行 `destroy()` → 目录 `X` 仍存在，预置文件内容不变。
（实现方式以 seam-test 现有 runtime 装配模式为准，不引入新测试框架。）

## 5.2 明确不做（审计项 E/F 的落实）

- 不改状态机、事件协议、verification、evaluation、memory。
- 不改 Pi 源码（零 diff）。
- 不动 `pi-paths.ts` 硬编码路径（那是 docs/14 的 P9-1，另行处理，不混入本步）。
- 不动 fallback plan（P9-2）、`checkStepAttempts`（P9-4）——记在债表上，不顺手修。
- 不新增 server/desktop 面（preflight、guard、journal、UI 都在后续步骤）。
- `~/.forge/tasks/` 下存量任务数据不迁移、不删除（v2 记录保持只读可用）。

## 5.3 验收标准（9.6.1 完成的定义）

1. `seam-test` 两条红线断言通过。
2. 现有 27 个单测、7 个 demo、benchmark 全绿（release-check.sh 全过）。
3. `grep -rn "rm(" src/runtime/` 只剩注释与 readiness 显式清理（readiness 清理对象是自建 readiness 子目录）。
4. 全仓库生产代码不存在任何以 `session.directory` / 任务工作目录为目标的删除调用。
5. typecheck 通过。

---

# 6. 验收标准 16 条 → 归属步骤映射（PM 验收用）

| # | 验收标准 | 当前 | 步骤 |
|---|---|---|---|
| 1–3 | 不需先选 Model/Provider/Workspace | ✗（Wizard 门槛） | 9.6.7 |
| 4 | 直接看到主界面 | ✗ | 9.6.7 |
| 5–6 | 查看/选择 Projects | 半成品（只存不执行） | 9.6.2 + 9.6.7 |
| 7 | 直接输入 Task | ✗（无入口） | 9.6.7 |
| 8 | 默认使用配置好的 Model | 部分（API 有，UI 无） | 9.6.7 |
| 9 | Model 未配置运行时才提示 | ✗（且失败原因不可见，C8） | 9.6.2 preflight |
| 10 | Agent 直接修改 active Project | ✗（shadow 沙箱） | 9.6.1 + 9.6.2 |
| 11 | 高风险 Tool Call 被拦截 | ✗ | 9.6.4 |
| 12 | Approve / Deny | ✗ | 9.6.5 |
| 13 | 查看 Diff | ✗ | 9.6.6 |
| 14 | Undo | ✗ | 9.6.6 |
| 15 | 不改 Orchestrator 状态机 | —（设计保证） | 全程约束 |
| 16 | Pi 源码零修改 | —（设计保证，已验证扩展机制可用） | 全程约束 |

---

# 7. 待产品经理确认（不阻塞 9.6.1）

1. Guard capability 默认策略（八类 read/write/edit/bash/delete/network/git/destructive 各自默认 allow/ask/deny）——docs/15 曾建议 bash=ask、write/edit=allow+journal，PM 已指示"具体默认策略另行设计"，9.6.4 开工前出草案。
2. "Allow always" 沉淀的规则存到全局 `~/.forge/guard.json` 还是 per-project？涉及信任边界。
3. 9.6.7 的 Welcome 文案与 empty state 内容。
