// 冒烟测试:dsh-session-notes 常驻 host(lib/index.js)
// 用 mock ctx/webServer/sessionController/workspaceRegistry 驱动真实 route handler,
// 验证设计文档 docs/design-working-loop.md 的核心路径。
// 运行:node test/smoke-host.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'snote-smoke-'))
process.env.DSH_HOME = home
const storeFile = join(home, 'storages', 'session-notes', 'notes.json')

const mod = await import('../lib/index.js')

// ---------- mock services ----------
const calls = { create: [], prompt: [], page: 0 }
let mockList = { items: [] }
const tailEvents = [] // seq asc;按 phase 注入
// dsh 0.1.5 契约:prompt/page 服务面第一步 signal.throwIfAborted()(裸调)——
// host 侧调用必须传第二参 AbortSignal。mock 复刻该契约,漏传直接红。
const requireSignal = (args) => {
  if (!(args[1] instanceof AbortSignal)) {
    throw new TypeError("cannot read properties of undefined (reading 'throwIfAborted')")
  }
}
const mockController = {
  async create(req) {
    calls.create.push(req)
    return { sessionId: 'sess-' + (calls.create.length), agentPreset: req.agentPreset }
  },
  async prompt(...args) { requireSignal(args); calls.prompt.push(args[0]); return { accepted: true } },
  async list() { return mockList },
  async page(...args) {
    requireSignal(args)
    calls.page++
    return { records: tailEvents.map((event) => ({ type: 'event', event })), hasMore: false }
  },
}
const mockRegistry = {
  archivedSessionIds: [],
  async resolveByPath(path) { return path ? { id: 'ws-' + path.slice(0, 8), path } : undefined },
}

let route = null
let disposers = []
const mkCtx = () => ({
  webServer: { register: (r) => { route = r; return () => { route = null } } },
  get: (name) => name === 'sessionController' ? mockController
    : name === 'workspaceRegistry' ? mockRegistry : undefined,
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
})

// ---------- HTTP helpers(直接驱动 route.handler) ----------
const ROOT = '/session-notes/api'
const resOf = () => {
  const r = { status: 0, body: '', writeHead(s, h) { this.status = s }, end(b) { this.body = b } }
  return r
}
const GET = async (path) => {
  const res = resOf()
  await route.handler({ method: 'GET', url: ROOT + path, headers: {} }, res)
  return JSON.parse(res.body)
}
const POST = async (path, body, headers) => {
  const res = resOf()
  const payload = JSON.stringify(body || {})
  const req = {
    method: 'POST', url: ROOT + path,
    headers: Object.assign({ 'sec-fetch-site': 'same-origin' }, headers || {}),
    on: (ev, cb) => {
      if (ev === 'data') cb(Buffer.from(payload))
      if (ev === 'end') cb()
    },
  }
  await route.handler(req, res)
  return JSON.parse(res.body)
}

const readStore = () => { try { return JSON.parse(readFileSync(storeFile, 'utf8')) } catch { return [] } }
const setStore = (notes) => {
  mkdirSync(join(home, 'storages', 'session-notes'), { recursive: true })
  writeFileSync(storeFile, JSON.stringify(notes, null, 2))
}

let failed = 0
const ok = (cond, name) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failed++ }
const section = (s) => console.log('\n== ' + s + ' ==')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const disposeAll = () => { disposers.forEach((d) => { try { d() } catch {} }); disposers = [] }

// ========== Phase 1:状态便签替换 + 任务创建(无定时) + 手动 spawn ==========
section('P1 状态便签 + 任务 CRUD + 手动 spawn')
{
  const ctx = mkCtx()
  mod.apply(ctx)
  await sleep(250) // boot pass

  // 先注入会话尾部事件(add 时的三层捕获与 spawn 时的窗口摘要都读它)
  tailEvents.length = 0
  tailEvents.push(
    { type: 'tool/result', seq: 1, time: Date.now() - 60_000, data: { content: [{ type: 'text', text: 'noise' }] } },
    { type: 'user/message', seq: 2, time: Date.now() - 50_000, data: { source: { kind: 'inject' }, content: [{ type: 'text', text: '合成注入应被跳过' }] } },
    { type: 'user/message', seq: 3, time: Date.now() - 40_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我看看 X 为什么失败' }] } },
    { type: 'assistant/message', seq: 4, time: Date.now() - 30_000, data: { content: [{ type: 'text', text: '结论:缓存层放在 fs-service 后面' }] } },
  )

  let r = await POST('/status-set', { workspacePath: '/tmp/proj', workspaceTitle: 'proj', text: '第一版状态' })
  ok(r.ok && r.note.kind === 'status', 'status-set 创建')
  r = await POST('/status-set', { workspacePath: '/tmp/proj', text: '第二版状态(替换)' })
  ok(r.ok && r.note.note === '第二版状态(替换)', 'status-set 替换正文')
  const st = readStore().filter((n) => n.kind === 'status')
  ok(st.length === 1 && st[0].note === '第二版状态(替换)', '同 workspace 只有一条 status')

  r = await POST('/add', {
    sessionId: 'origin-1', workspacePath: '/tmp/proj', quote: '把缓存层放在 fs-service 后面',
    note: '验证缓存层方案', kind: 'task', next: '跑冒烟', doneWhen: '测试全绿',
  })
  ok(r.ok && r.note.kind === 'task' && r.note.origin.sessionId === 'origin-1', '任务创建 + origin 记录')
  ok(r.note.excerpt && r.note.excerpt.intent === '帮我看看 X 为什么失败', '三层捕获:intent')
  ok(r.note.excerpt && r.note.excerpt.containing.includes('缓存层'), '三层捕获:containing')

  // 手动 spawn:开场消息结构 + 8K 顶 + spawnLog + dueAt 清空
  const taskNote = readStore().find((n) => n.kind === 'task')
  r = await POST('/spawn', { id: taskNote.id })
  ok(r.ok && r.sessionId === 'sess-1', '手动 spawn 返回 sessionId')
  const opened = calls.create[0]
  ok(opened && !!opened.workspaceId, 'create 带 workspaceId(解析自 workspacePath)')
  ok(calls.prompt.length === 1, 'prompt 调用一次')
  const opening = calls.prompt[0].content[0].text
  ok(opening.includes('【便签任务】验证缓存层方案'), '开场:任务头')
  ok(opening.includes('下一步：跑冒烟') && opening.includes('完成条件：测试全绿'), '开场:next/doneWhen')
  ok(opening.includes('高亮原文') && opening.includes('当时的提问'), '开场:三层捕获')
  ok(opening.includes('[user] 帮我看看 X 为什么失败'), '开场:窗口摘要含真人 user 消息')
  ok(!opening.includes('合成注入应被跳过') && !opening.includes('noise'), '窗口摘要过滤注入/tool 噪音')
  ok(opening.includes('工作台当前状态') && opening.includes('第二版状态(替换)'), '开场:status 快照')
  ok(opening.includes('复述任务'), '开场:起手指示(复述)')
  ok(opening.length <= 8000, '开场 ≤ 8000 字符(实际 ' + opening.length + ')')
  const after = readStore().find((n) => n.id === taskNote.id)
  ok(after.spawnLog.length === 1 && after.spawnLog[0].sessionId === 'sess-1', 'spawnLog 回填')
  ok(!after.dueAt, '手动 spawn 清空 dueAt')

  const listRes = await GET('/list')
  ok(listRes.ok && listRes.notes.length >= 2, '/list 正常')
  disposeAll()
}

// ========== Phase 2:boot 补射(auto)+ 一次性闩锁 ==========
section('P2 调度:auto 补射 + 闩锁')
{
  const duePast = new Date(Date.now() - 120_000).toISOString()
  setStore([{
    id: 'task-auto', kind: 'task', note: '到点自动跑', next: '', doneWhen: '',
    done: false, dueAt: duePast, dueAction: 'auto', preset: '',
    sessionId: '', workspacePath: '/tmp/proj', workspaceTitle: 'proj', quote: '',
    origin: { sessionId: 'origin-2', createdAt: new Date(Date.now() - 60_000).toISOString() },
    createdAt: duePast, updatedAt: duePast,
  }])
  const n0 = calls.create.length
  const p0 = calls.prompt.length
  mockList = { items: [{ sessionId: 'origin-2', cwd: '/tmp/proj' }] } // 来源会话存活,不降级
  const ctx = mkCtx()
  mod.apply(ctx)
  await sleep(250)
  const t = readStore().find((x) => x.id === 'task-auto')
  ok(calls.create.length === n0 + 1, '过期 auto 任务 boot 即 spawn')
  ok(t.firedAt && t.fireState === 'fired', '闩锁 + fireState=fired')
  ok(!t.originLost, '来源存活未误判删除')
  ok((t.spawnLog || []).length === 1 && t.spawnLog[0].auto === true, 'spawnLog.auto=true')
  ok(calls.prompt.length === p0 + 1 && calls.prompt[p0].mode === 'queue', 'prompt mode=queue')
  disposeAll()
}

// ========== Phase 3:notify 只亮角标;done 不触发 ==========
section('P3 notify 与 done 语义')
{
  const duePast = new Date(Date.now() - 60_000).toISOString()
  setStore([
    { id: 'task-notify', kind: 'task', note: '到点提醒', done: false, dueAt: duePast, dueAction: 'notify', preset: '', quote: '', workspacePath: '/tmp/proj', origin: { sessionId: '', createdAt: duePast }, createdAt: duePast, updatedAt: duePast },
    { id: 'task-done', kind: 'task', note: '已完成不该触发', done: true, dueAt: duePast, dueAction: 'auto', preset: '', quote: '', workspacePath: '/tmp/proj', origin: { sessionId: '', createdAt: duePast }, createdAt: duePast, updatedAt: duePast },
  ])
  const n0 = calls.create.length
  const ctx = mkCtx()
  mod.apply(ctx)
  await sleep(250)
  const tn = readStore().find((x) => x.id === 'task-notify')
  const td = readStore().find((x) => x.id === 'task-done')
  ok(calls.create.length === n0, 'notify 与 done 都不开会话')
  ok(tn.firedAt && !(tn.spawnLog || []).length, 'notify 只落 firedAt')
  ok(!td.firedAt, 'done 任务连闩锁都不落')
  const r = await POST('/ack', { id: 'task-notify', action: 'dismiss' })
  ok(r.ok && r.note.notifyDismissed === true, 'ack dismiss')
  disposeAll()
}

// ========== Phase 4:来源会话删除检测 + 降级 + 恢复 ==========
section('P4 检测降级')
{
  const dueFuture = new Date(Date.now() + 3600_000).toISOString()
  setStore([{
    id: 'task-los', kind: 'task', note: '来源会话将被删', done: false,
    dueAt: dueFuture, dueAction: 'auto', preset: '', quote: '', workspacePath: '/tmp/proj',
    origin: { sessionId: 'ghost-1', createdAt: dueFuture }, createdAt: dueFuture, updatedAt: dueFuture,
  }])
  mockList = { items: [{ sessionId: 'other', cwd: '/other' }] } // ghost-1 不在列表 ⇒ 已删除
  const ctx = mkCtx()
  mod.apply(ctx)
  await sleep(250)
  const t = readStore().find((x) => x.id === 'task-los')
  ok(t.originLost && t.downgraded === true, '来源消失 → originLost + auto 降级')
  let r = await POST('/ack', { id: 'task-los', action: 'restore-auto' })
  ok(r.note.downgraded === false && r.note.dueAction === 'auto', 'ack restore-auto')
  r = await POST('/ack', { id: 'task-los', action: 'cancel-due' })
  ok(!r.note.dueAt && !r.note.firedAt, 'ack cancel-due 清定时')
  disposeAll()
}

// ========== Phase 5:崩溃恢复 creating 残留 ==========
section('P5 崩溃恢复')
{
  setStore([{
    id: 'task-crash', kind: 'task', note: '崩在 creating', done: false,
    dueAt: new Date(Date.now() - 60_000).toISOString(), dueAction: 'auto', preset: '', quote: '',
    workspacePath: '/tmp/proj', firedAt: new Date(Date.now() - 30_000).toISOString(), fireState: 'creating',
    spawnLog: [], origin: { sessionId: '', createdAt: new Date().toISOString() },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }])
  const n0 = calls.create.length
  const ctx = mkCtx()
  mod.apply(ctx)
  await sleep(250)
  const t = readStore().find((x) => x.id === 'task-crash')
  ok(t.fireState === 'failed', 'creating 残留 → failed(宁漏勿双)')
  ok(calls.create.length === n0, '恢复不自动补开')
  disposeAll()
}

// ========== Phase 6:同源门 + 越界路径 ==========
section('P6 同源门')
{
  const ctx = mkCtx()
  mod.apply(ctx)
  await sleep(150)
  const r = await POST('/add', { note: 'x' }, { 'sec-fetch-site': 'cross-site' })
  ok(r.ok === false, '跨源写被拒')
  disposeAll()
}

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'))
rmSync(home, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
