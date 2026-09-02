# Forge 9.6 验收手册（docs/18）

> 面向产品经理的端到端验证步骤。目标：跑通 16 条验收标准，重点验证三件事——
> 审批环路（ask→卡片→放行）、Diff/Undo Journal、guard deny。
> 前提：repo 在 `/Users/hcq/forge`，已装 Node ≥22 + Rust toolchain。

---

# 0. 环境准备

```bash
# 1) 全量回归（21/21 应全绿）
bash scripts/release-check.sh

# 2) 准备一个测试项目（不要用真实重要项目做第一轮）
mkdir -p ~/forge-test && cd ~/forge-test
git init -b main
git config user.email you@example.com
git config user.name you
echo "export function add(a,b){return a+b}" > calc.ts
git add -A && git commit -m init
```

# 1. 启动桌面（两阶段）

```bash
# 终端 A：前端 dev server
cd /Users/hcq/forge/desktop && npm run dev

# 终端 B：Tauri shell（首次编译较慢）
cd /Users/hcq/forge/desktop/src-tauri && \
  FORGE_ROOT=/Users/hcq/forge \
  cargo tauri dev
```

- 终端 B 看到 `sidecar started`、`server ready` 字样说明侧车起来了；
  `~/.forge/server.json` 存在。**如果没起**：多半是漏了 `FORGE_ROOT`。
- 不开 Tauri 也能验证：终端 C 里 `FORGE_HOME=$HOME/.forge node --import tsx/esm src/cli/serve.ts --port 5300`，
  但前端拿不到 token，所以**桌面验证必须走 Tauri**。

# 2. 无模型模式（先验 UI 流，不花 token）

```bash
# 让侧车用 fake runtime（不调 LLM，任务秒完）
FORGE_ROOT=/Users/hcq/forge FORGE_RUNTIME=fake cargo tauri dev
```

| 检查点 | 操作 | 预期 |
|---|---|---|
| 首屏无门槛 | 启动 | 直接进主界面；Welcome 弹一次、可关；无 Model/Workspace 强制选择 |
| Projects | + Add Project → 填 `~/forge-test` | 出现在列表；点选后侧边栏出现 ACTIVE |
| 创建任务 | + New Task → 输入目标、选项目 → Run | preflight 通过 → 任务秒变 COMPLETE（fake runtime） |
| 取消不删数据 | 跑一个 `FORGE_RUNTIME=fake` 任务期间点停止，或任务完成后 | **`ls ~/forge-test` 目录原样存在**（9.6.1 红线回归） |

# 3. 有模型模式（完整功能验证）

## 3.1 配置

1. Settings → 选 MiniMax（或 Anthropic）→ 填 API Key → **Run Readiness Check** → 应 5 项 PASS。
2. **OpenAI Compatible（自定义端点）**：Settings 选 "OpenAI Compatible" → 填 Base URL、API Key、Model ID →
   选 **API protocol**（OpenAI chat/completions / OpenAI responses / Anthropic messages，对应网关是哪种协议选哪个）→ Save。
   保存后 Forge 会把自定义 provider 写进 Pi 的 `~/.forge/pi-agent/models.json`（不影响你自己的 `~/.pi/`），
   任务通过 `--provider custom` 启动。验证：Settings 里 Test Connection 应走所选协议并 PASS。
3. 可选：减少审批打扰，先放宽松策略：

```bash
cat > ~/.forge/guard.json <<'EOF'
{ "version": 1, "default": "ask",
  "rules": [
    { "id": "read-allow", "capability": "read", "decision": "allow" },
    { "id": "destructive-deny", "capability": "destructive", "decision": "deny", "terminate": true },
    { "id": "write-allow", "capability": "write", "decision": "allow" },
    { "id": "edit-allow", "capability": "edit", "decision": "allow" },
    { "id": "bash-ask", "capability": "bash", "decision": "ask" }
  ]}
EOF
# 恢复默认：rm ~/.forge/guard.json
```

## 3.2 黄金任务（一条龙覆盖审批 + diff + undo）

在 `~/forge-test` 上创建任务，目标：

> "Add a divide function to calc.ts that returns a divided by b, and run the tests"

| 阶段 | 观察 | 预期 |
|---|---|---|
| UNDERSTAND→PLAN | TaskDetail Plan 面板 | 出现 step 列表 |
| EXECUTE | agent 写文件 / 跑命令 | write 放行（宽松策略）；**bash 弹右下角审批卡** |
| 审批 | 点 **Approve** | 卡片消失，命令执行，任务继续 |
| 审批拒绝 | 再给一条会跑 bash 的任务，点 **Deny** | 工具被拒；任务可能在 FIX 后失败，失败原因含 `forge-guard: rejected by user` |
| OBSERVE/EVALUATE/COMPLETE | 状态流转 | 全程可跟踪；COMPLETE 后出 Evaluation |

## 3.3 Changes 面板 + Undo

| 检查点 | 操作 | 预期 |
|---|---|---|
| Diff（git） | 任务完成后看 TaskDetail → Changes | 显示 `git diff vs <head>`，含 calc.ts 变更 + status |
| Undo | 点 **Undo** | 提示 N 个文件恢复；calc.ts 回到任务前内容；diff 清空 |
| 非 git 项目 | 用非 git 目录建项目跑任务 | Changes 显示变更清单（◆/＋ + 大小），Undo 同样可用 |

## 3.4 guard deny 端到端

```bash
cat > ~/.forge/guard.json <<'EOF'
{ "version": 1, "default": "ask",
  "rules": [
    { "id": "read-allow", "capability": "read", "decision": "allow" },
    { "id": "deny-npm-test", "capability": "bash", "contains": "npm test", "decision": "deny" },
    { "id": "bash-allow", "capability": "bash", "decision": "allow" },
    { "id": "write-allow", "capability": "write", "decision": "allow" }
  ]}
EOF
```

任务目标："run npm test and report" → agent 调用 `npm test` 时**直接被拒**（不弹卡），
任务失败原因含 `forge-guard: deny by rule deny-npm-test`。验证完 `rm ~/.forge/guard.json` 恢复默认。

## 3.5 错误路径

| 检查点 | 操作 | 预期 |
|---|---|---|
| 无 Key 快速失败 | 清空 Settings 的 Key，建任务 | 不烧预算，立即报 `no API key configured`，错误页有 Fix in Settings |
| 并发锁 | 同项目连续建两个任务 | 第二个报 `workspace is busy`（409） |
| 运行中 Undo | 任务跑着点 Undo | 拒绝：`task is still running`（409） |

# 4. 验收标准 16 条对照

| # | 标准 | 验证位置 |
|---|---|---|
| 1–3 | 不需先选 Model/Provider/Workspace | §2 首屏 |
| 4 | 直进主界面 | §2 |
| 5–6 | Projects 查看/选择 | §2 |
| 7–8 | 直接输入 Task / 默认 Model | §2 / §3.1 |
| 9 | 无 Model 运行时才提示 | §3.5 |
| 10 | Agent 直接改 active Project | §3.2（calc.ts 被改 = 就地执行生效） |
| 11 | 高风险 Tool Call 被拦截 | §3.4 |
| 12 | Approve / Deny | §3.2 |
| 13 | Diff | §3.3 |
| 14 | Undo | §3.3 |
| 15 | 状态机未改 | 全程状态流转与 10 态一致即可 |
| 16 | Pi 零修改 | `git -C /Users/hcq/forge/pi status` 应显示干净 |

# 5. 已知限制（本手册不覆盖）

- **原生文件夹选择器**：Tauri 未装 dialog 插件，ProjectsPage 用文本路径输入。
- **审批环路自证边界**：§3.2 的审批卡是完整的端到端验证——这也是我之前唯一不敢打包票的链路，跑通即闭环。
- 侧车固定 5300 端口：端口被占时改 `desktop/src-tauri/src/lib.rs` 的 `PORT`。
