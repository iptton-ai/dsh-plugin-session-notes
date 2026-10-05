# 会话便签 → 跨会话工作台：设计文档

> 灵感来源：[yeaa-labs/project-working-loop](https://github.com/yeaa-labs/project-working-loop)（Codex Skill，用单份
> Markdown 控制文件管理跨会话项目进度）。本文档把「做着做着不知做到哪了」的解法
> 嫁接到 dsh-session-notes 的存储与 UI 上，并按四轮讨论收敛的决策落地。
>
> 2026-09-09 讨论定稿。适用形态：**常驻插件（lib/，profile link 安装）**。
> 动态形态（src/，cordis_define）仅做数据兼容，不含调度/spawn。

## 0. 问题与解法概览

| 痛点 | 解法 | 来源 |
| --- | --- | --- |
| 不知做到哪了 | status 便签（每 workspace 一条活跃，更新=替换）+ 面板顶部 Current 行 | Current 派生状态行 |
| 不知算不算完 | 任务便签 `doneWhen` 验收条件先行，完成=勾选不删除 | Done when |
| 不知接下来干嘛 | 任务便签 `next` 字段，恢复时照做 | Next |
| 便签越记越多回看慢 | status 替换式更新（不是 running log）；任务完成后压缩为勾选态 | compaction, not append |
| 想新起会话干活 | 任务便签「▶ 新会话」spawn 按钮（V1） | ticket/run 模型 |
| 想到点自动开始 | `dueAt` 落盘 + host 60s 扫描，默认 auto-spawn，可选 notify（V2） | 事件是数据，触发是哑扫描 |
| 无人值守会话的上下文 | 开场消息 = 便签 + 三层捕获 + 窗口摘要 + 起手指示，8K 裁剪阶梯 | 全世界观是开场消息 |

## 1. 数据模型（notes.json 数组元素）

在现有字段（id/sessionId/workspacePath/workspaceTitle/quote/note/createdAt/updatedAt）之上扩展：

```jsonc
{
  "kind": "note | status | task",       // 缺省视为 note（兼容旧数据）
  // ---- task 专有 ----
  "next": "",                            // 下一个动作
  "doneWhen": "",                        // 可观察的验收条件
  "done": false,                         // 完成勾选（勾选后调度器永不触发）
  "dueAt": "",                           // ISO 时间；设置了才参与调度；一次性
  "dueAction": "auto | notify",          // 到点动作，默认 auto
  "preset": "",                          // agent 预设 id；创建时捕获当前会话的 preset 作默认
  // ---- 所有 kind 都有 ----
  "origin": { "sessionId": "", "createdAt": "" },   // 溯源（≠归属范围）
  "excerpt": { "containing": "", "intent": "" },    // 三层捕获的后两层（第一层是 quote）
  // ---- 调度状态（host 写）----
  "firedAt": "",                         // dueAt 触发时间（一次性闩锁）
  "fireState": "",                       // creating|fired|failed（三段落盘防双开）
  "spawnLog": [ { "sessionId": "", "at": "", "auto": false } ],
  "originLost": "",                      // 检测到来源会话已删除的时间
  "originArchived": false,               // 来源会话已归档（软提示，不降级）
  "downgraded": false,                   // originLost 导致 auto→notify 降级
  "notifyDismissed": false               // notify 角标的用户忽略
}
```

关键语义：

- **status 便签**：每 workspace 一条活跃；`/status-set` 为创建或**替换**（更新正文与
  updatedAt，不追加历史）。存储层不做唯一性约束之外的展开（不做历史版本，v1 从简）。
- **task 一次性语义**：`firedAt` 一经写入不再触发；重试是手动动作（决策卡/卡片按钮），
  没有日历逻辑、没有 repeat。
- **origin ≠ scope**：所有便签创建时都记录来源会话 id（session/workspace/global 便签
  都记），spawn 时窗口摘要靠它定位。
- **手动 spawn 清空调度**：手动「▶ 新会话」视为用户已行动，清空 dueAt/dueAction
  （避免稍后 auto 再开一个重复会话）。

## 2. spawn：从便签开新会话

### 2.1 流程（host 侧统一函数，手动/自动共用）

```
spawnNote(id, {auto}):
  1. 闩锁：写 firedAt + fireState='creating' → 落盘（防双开第一段）
  2. 定位：cwd = note.workspacePath || 来源会话 cwd（list() 缓存兜底）|| undefined
     workspaceId = workspaceRegistry.resolveByPath(cwd)?.id（能解析则带，spawn 的会话
     落进工作区侧栏）
  3. 摘要：buildDigest(note)（见 §3.2，失败静默跳过）
  4. 开场消息：buildOpening(note, digest, statusNote)（见 §3.3，8K 裁剪）
  5. sessionController.create({ workspaceId?/cwd?, agentPreset: note.preset || undefined })
  6. sessionController.prompt({ requestId:'snote-'+id+'-'+firedAt, sessionId,
     mode:'queue', content:[{type:'text', text:开场消息}] })   ← requestId 幂等
  7. 补账：spawnLog.push + fireState='fired' → 落盘（第三段）
  崩溃恢复：启动时发现 fireState='creating' 且无对应 spawnLog → 标记 failed 并在
  面板浮出「上次启动失败 [重试]」，绝不自动补开（宁漏勿双）。
```

### 2.2 内部 API 面（已核实，dsh 0.1.3-alpha.x web-app bundle）

| 调用 | 用途 |
| --- | --- |
| `ctx.sessionController.create({workspaceId?|cwd?, agentPreset?})` → `{sessionId, agentPreset?}` | 开会话（TypertRemoteService，super(ctx,'sessionController')） |
| `ctx.sessionController.prompt({requestId, sessionId, mode:'queue', content:[{type:'text',text}]})` | 发开场消息；requestId 幂等 |
| `ctx.sessionController.list()` → `{items:[{sessionId, cwd, updatedAt,…}]}` | 删除检测轮询 + cwd 兜底 |
| `ctx.sessionController.page({address:{kind:'session',sessionId}, throughSeq:-1, maxMessages:N})` → `{records:[{type:'event',event:{type,seq,time,data}}]}` | 窗口摘要（cold 会话可读；-1=最新） |
| `ctx.workspaceRegistry.archivedSessionIds`（同步 getter） | 归档检测 |
| `ctx.workspaceRegistry.resolveByPath(path)` → entity(.id) | workspaceId 解析 |
| `ctx.sessions.get(id)` + `ctx.sessionProjections.stateOf(session,'agentPreset')` | 创建时捕获 preset 默认（best-effort） |

事件形状：`event.type ∈ {'user/message','assistant/message',…}`，`event.time` 为
Unix epoch ms，`event.data` 即消息对象（`content:[{type:'text',text},…]`、
`source.kind`）。用户消息 `source.kind==='user'`（合成注入是别的 kind）。

### 2.3 客户端联动

手动 spawn 成功后 `ctx.sessions.open(sessionId)` 跳转新会话（resident client
inject `sessions`，与 dsh-files 同款）；失败则 toast 出 sessionId。

## 3. 开场消息：无人值守会话的全部世界观

### 3.1 三层捕获（创建时，host 侧 page()，不用 DOM 遍历）

记便签时 host 对来源会话取 page(-1)：

1. **quote**（已有）——高亮原文，精确；
2. **excerpt.containing**——≤ 创建时刻最近一条 assistant 消息（截 2000，头尾保留）；
3. **excerpt.intent**——≤ 创建时刻最近一条 `source.kind==='user'` 的用户消息（截 500），
   即「当时的提问」，任务意图最自然的陈述。

高亮落在更早的消息上时，由 spawn 时的窗口摘要兜底。全部 best-effort try/catch。

### 3.2 窗口摘要（spawn 时，机械截取，无 LLM）

对来源会话 page(-1, maxMessages≈40)，过滤：
- `event.type ∈ {'user/message','assistant/message'}`（跳过 tool 噪音）；
- 用户消息仅保留 `source.kind==='user'`（跳过合成注入）；
- 时间窗 `[note.origin.createdAt − 30min, note.origin.createdAt]`（锚定创建时刻，
  用户记完便签继续聊别的也不会污染窗口）；
- 每条截 ~600 字，最多 6 条，总量 ≤3K。

来源会话已删/读失败 → 静默跳过（三层捕获是兜底，这正是它存在的理由）。

### 3.3 组装与 8K 裁剪阶梯

```
【便签任务】<note 正文>

## 任务
- 下一步：<next>
- 完成条件：<doneWhen | (未设置，自行判断并在完成后说明)>

## 来源上下文（来自会话高亮）
> 高亮原文："…"
> 所在消息（节选）：…
> 当时的提问：…

## 来源会话尾声（便签创建前 30 分钟，节选）
[user] … / [assistant] …

## 工作台当前状态
<status 便签快照>

## 起手指示
你是一次（可能无人值守的）任务会话，以上是你的全部背景。第一步：用自己的话
复述任务、完成条件和已知结论，然后开始执行。若来源会话无法读取且上述背景
不足以安全执行任务：停下来，明确列出你缺什么信息，等待用户指示，不要靠猜测推进。
需要更多上下文时可尝试读取来源会话 <sessionId>。
```

总量硬顶 **8000 字符**，裁剪顺序固定（越靠近「任务是什么」越后死）：

| 优先级 | 区块 | 预算 | 超限砍法 |
| --- | --- | --- | --- |
| 永不砍 | 任务字段 + 高亮原文 + 当时的提问 + 起手指示 | ~1.5K+1K | — |
| 先砍 | 窗口摘要 | ≤3K | 先截每条，再从最旧条目开始丢 |
| 后砍 | 所在消息节选 | ≤2K | 砍尾保头 |
| 弹性 | status 快照 | 余量 | 最后截断 |

### 3.4 明确不做：插件侧 LLM 总结

总结由被 spawn 会话里的 agent 在「复述任务」这一步自己做。插件侧 LLM 调用
（依赖/费用/过期/有损四害）只有当机械方案实测臃肿时才作为体积优化引入。

## 4. 调度器（host，lib/index.js）

- **事实源是落盘数据**：60s `setInterval` 扫描 notes.json，不用 setTimeout 记状态。
  启动时先跑一次检测轮询再 sweep（过期 auto 任务照常自动开——一次性闩锁保证不会
  连环补射）。
- **触发条件**：`kind==='task' && !done && dueAt && !firedAt && now >= dueAt`。
  已勾 done 的永不触发。
- **auto**：调 `spawnNote(id,{auto:true})`。**notify**：只写 firedAt + 面板亮角标，
  用户一键「开跑」（= 手动 spawn 路径）或「忽略」。
- **透明性**：编辑器里设置了 dueAt 时明确显示「到点将自动新会话（preset：XX）」，
  自主性不藏在数据里，但也不做确认墙。

## 5. 来源会话删除/归档：三层防线

| 层 | 时机 | 动作 |
| --- | --- | --- |
| T1 检测 | host 每 3min 轮询 `sessionController.list()` + `workspaceRegistry.archivedSessionIds` | 来源会话从 list 消失 → 写 `originLost`；**未触发的 auto 任务自动降级为 notify**（`downgraded:true`），面板浮出决策卡：[照常自动跑]（恢复 auto）[取消定时] [编辑]。归档 → 仅标 `originArchived`（软提示，日志仍可读，不降级） |
| T2 守卫 | 轮询缝隙漏过的（删除发生在两次轮询之间/重启窗口） | 开场消息「起手指示」内含停止条款：背景不足→停下来列出缺什么，等用户指示 |
| T0 兜底 | 任何时刻 | 三层捕获存在 notes.json 里，不随会话消亡；任务最多降级、不会失效 |

**明确不做**：检测到删除后自动删除任务（创建时捕获特意保住最小世界观，静默删
用户任务是最惊吓行为）。T1 命中给了我们在烧掉会话之前问一句的机会，所以降级
而不是放行；T2 只兜没问到的。

## 6. 面板 UI（client，lib/client.js）

- **Current 状态行**：面板列表顶部渲染当前 workspace 的 status 便签（一行卡片，
  点击编辑；无则显示「＋ 设为当前状态」）。
- **编辑器**：类型选择（便签/状态/任务）。任务态展开：下一步、完成条件、定时
  （datetime-local + 快捷「明早 9 点」「5 小时后」）、到点动作（自动开新会话/仅提醒）、
  preset（文本输入，预填捕获默认，留空=部署默认）。状态态：归属强制 workspace。
- **任务卡片**：完成勾选框、next/doneWhen 摘要行、dueAt 状态徽标
  （待触发/已触发/auto 已开跑/已降级/失败重试）、「▶ 新会话」按钮。
- **决策卡**：originLost 且有未触发定时的任务 → 面板顶部黄色警示卡 + 三按钮。
- **轮询**：面板打开期间每 20s 拉一次 /list（auto-spawn 结果、角标状态自动浮现）。

## 7. API 增量（同源 /session-notes/api/*，写操作带同源门）

| 路由 | 请求 | 响应 |
| --- | --- | --- |
| `POST /update`（扩展） | `{id, note?, kind?, next?, doneWhen?, done?, dueAt?, dueAction?, preset?}` | `{ok, note}` |
| `POST /status-set` | `{workspacePath, workspaceTitle, text}` | `{ok, note}`（创建或替换） |
| `POST /spawn` | `{id}` | `{ok, sessionId}` |
| `POST /ack` | `{id, action:'run'|'dismiss'|'restore-auto'|'cancel-due'}` | `{ok, note?}` |

## 8. 分期与形态边界

- **V1**（本次实现）：schema + 手动 spawn + 三层捕获 + Current 状态行 + 任务 UI。
- **V2**（本次实现）：dueAt 调度 + auto/notify + 启动补射 + T1 检测降级 + 决策卡。
- **V3**（部分实现）：spawnLog 已落盘并在卡片显示「上次尝试」；「未完成重试」=
  手动再点 spawn。
- **动态形态（src/）**：只透传新 schema 字段（add/update 不丢数据），无调度无
  spawn（sessionController 不在其 ctx 里）——README 注明任务/调度需常驻形态。

## 9. 已验证的边界行为

- prompt 的 requestId 幂等：同 requestId 重复提交返回 accepted，不重复入队。
- page() `throughSeq:-1` 合法（=最新 cut）；cold 会话可读（sourceFor 不要求 live）。
- create() 传 workspaceId 与 cwd 互斥；都不传则落到部署默认 cwd。
- prompt 前提是会话有可用模型路由：新会话继承部署默认模型选择，无需 selectModel。
