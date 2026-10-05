// dsh-session-notes — 节点半边:便签 JSON 存储 + 同源 API(/session-notes/api/*)
//                              + 任务调度器(dueAt 扫描) + 便签→新会话 spawn
//                              + 来源会话删除/归档检测。
//
// 设计文档:docs/design-working-loop.md(2026-09-09 讨论定稿)。
//
// 常驻形态(profile 插件)直接使用 Node 内置 API——web 壳组合不提供 fs/shell
// 服务(那些挂在 agent 会话域),而本插件在产品信任域内,与 dsh-grok-media 等
// 常驻插件同级,不受文件沙箱围栏约束。
//
// 存储:~/.dsh/storages/session-notes/notes.json(temp+rename 原子写,写队列
// 失败隔离)。
// API(写操作带同源门):
//   GET  /list                                  → {ok, notes}
//   POST /add    {sessionId, workspacePath, …}  → {ok, note}(含三层捕获+origin)
//   POST /update {id, note?, kind?, next?…}     → {ok, note}
//   POST /delete {id}                           → {ok}
//   POST /status-set {workspacePath, text}      → {ok, note}(创建或替换状态便签)
//   POST /spawn  {id}                           → {ok, sessionId}(手动开新会话)
//   POST /ack    {id, action}                   → {ok, note?}
//   POST /diag   {key, …}                       → {ok}(诊断落 dsh-web.log)

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const inject = ['webServer', 'sessionController', 'workspaceRegistry']

const ROOT = '/session-notes/api'

// ---- 调度常量(见设计文档 §3.3/§4) ----
const SWEEP_INTERVAL_MS = 60_000          // dueAt 扫描周期
const DETECT_INTERVAL_MS = 180_000        // 来源会话存活检测周期
const OPENING_HARD_CAP = 8000             // 开场消息总量硬顶(字符)
const DIGEST_WINDOW_MS = 30 * 60_000      // 窗口摘要:创建时刻前 30 分钟
const DIGEST_MAX_ENTRIES = 6
const DIGEST_ENTRY_CHARS = 600
const DIGEST_BUDGET = 3000
const EXCERPT_CONTAINING_CHARS = 2000
const EXCERPT_INTENT_CHARS = 500
const NOTE_MAX = 4000
const QUOTE_MAX = 2000

const errText = (e) => String((e && e.message) || e)
const nowIso = () => new Date().toISOString()
const clampStr = (v, n) => String(v ?? '').slice(0, n)
// dsh 0.1.5 起 sessionController 的 prompt/page 服务面第一步就 signal.throwIfAborted()
// (裸调,无 ?.),host 侧调用必传第二参;本插件无取消语义,给一根永不中止的新 signal。
const freshSignal = () => new AbortController().signal

const read = (req) => new Promise((resolve) => {
  const chunks = []
  req.on('data', (x) => chunks.push(x))
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')) } catch { resolve(null) }
  })
})

const send = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** 同源门:浏览器跨源请求拒;非浏览器客户端由部署面把守。 */
const sameOrigin = (req) => {
  const sfs = req.headers['sec-fetch-site']
  if (sfs !== undefined) return sfs === 'same-origin' || sfs === 'none'
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const o = new URL(origin)
    return o.host === req.headers.host
  } catch {
    return false
  }
}

/** 从一条消息对象(dsh-llm Message)提取纯文本。 */
const messageText = (data) => {
  const content = data && Array.isArray(data.content) ? data.content : []
  let out = ''
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') {
      if (out) out += '\n'
      out += part.text
    }
  }
  return out.trim()
}

export function apply(ctx) {
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const file = join(dshHome, 'storages', 'session-notes', 'notes.json')
  console.log('session-notes store at', file)

  const sessionController = () => ctx.get('sessionController')
  const workspaceRegistry = () => ctx.get('workspaceRegistry')

  let cache = null
  let queue = Promise.resolve()
  /** 来源会话 cwd 缓存(检测轮询顺带维护;全局便签 spawn 的 cwd 兜底)。 */
  let sessionCwds = new Map()

  async function readAll() {
    if (cache !== null) return cache
    let text = ''
    try { text = await readFile(file, 'utf8') } catch (e) {
      if (e && e.code !== 'ENOENT') console.error('session-notes read failed:', errText(e))
    }
    let arr = []
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        arr = parsed.filter((x) => x && typeof x === 'object' && typeof x.id === 'string')
      }
    } catch { arr = [] }
    if (text) console.log('session-notes loaded', arr.length, 'notes')
    cache = arr
    return arr
  }

  /** temp+rename 原子写;失败只影响当次调用,队列不残留 rejection。 */
  function persist() {
    const attempt = queue.then(async () => {
      await mkdir(join(dshHome, 'storages', 'session-notes'), { recursive: true })
      const tmp = file + '.' + Date.now().toString(36) + '.tmp'
      await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8')
      await rename(tmp, file)
    })
    queue = attempt.catch(() => {})
    return attempt
  }

  const findNote = (id) => cache.find((n) => n.id === id)

  // ---------- 三层捕获:创建时读来源会话尾部(§3.1) ----------
  /** page() 读取会话最近事件(cold 可读;失败返回 [])。 */
  async function readTailEvents(sessionId, maxMessages) {
    const sc = sessionController()
    if (!sc || !sessionId) return []
    try {
      const page = await sc.page({
        address: { kind: 'session', sessionId },
        throughSeq: -1,
        maxMessages,
      }, freshSignal())
      const records = page && Array.isArray(page.records) ? page.records : []
      return records
        .map((r) => r && r.event)
        .filter((e) => e && typeof e.seq === 'number')
        .sort((a, b) => a.seq - b.seq)
    } catch (e) {
      console.warn('session-notes page failed for', sessionId, errText(e))
      return []
    }
  }

  /**
   * 三层捕获的后两层:≤now 最近一条 assistant 消息(containing)与最近一条
   * 真人用户消息(intent)。quote(第一层)由客户端随选区带来。
   */
  async function captureExcerpt(sessionId) {
    const events = await readTailEvents(sessionId, 24)
    let containing = ''
    let intent = ''
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.time && Date.now() - ev.time > 24 * 3600_000) break // 只看最近一天
      const data = ev.data
      if (!data || !Array.isArray(data.content)) continue
      if (!containing && ev.type === 'assistant/message') {
        containing = clampStr(messageText(data), EXCERPT_CONTAINING_CHARS)
      } else if (!intent && ev.type === 'user/message' && data.source && data.source.kind === 'user') {
        intent = clampStr(messageText(data), EXCERPT_INTENT_CHARS)
      }
      if (containing && intent) break
    }
    return { containing, intent }
  }

  /** 创建时捕获当前会话的 agent preset(best-effort,冷会话拿不到)。 */
  function capturePreset(sessionId) {
    try {
      const session = ctx.get('sessions')?.get(sessionId)
      if (!session) return ''
      const preset = ctx.get('sessionProjections')?.stateOf(session, 'agentPreset')
      return typeof preset === 'string' ? preset : ''
    } catch { return '' }
  }

  // ---------- 窗口摘要:spawn 时机械截取(§3.2) ----------
  async function buildDigest(note) {
    const originId = note.origin && note.origin.sessionId
    if (!originId) return ''
    const anchorMs = Date.parse((note.origin && note.origin.createdAt) || note.createdAt || '')
    if (!Number.isFinite(anchorMs)) return ''
    const events = await readTailEvents(originId, 40)
    const picked = []
    for (let i = events.length - 1; i >= 0 && picked.length < DIGEST_MAX_ENTRIES; i--) {
      const ev = events[i]
      if (ev.time == null || ev.time > anchorMs || ev.time < anchorMs - DIGEST_WINDOW_MS) continue
      const data = ev.data
      if (!data || !Array.isArray(data.content)) continue
      let role = null
      if (ev.type === 'assistant/message') role = 'assistant'
      else if (ev.type === 'user/message' && data.source && data.source.kind === 'user') role = 'user'
      if (!role) continue
      const text = clampStr(messageText(data), DIGEST_ENTRY_CHARS)
      if (!text) continue
      picked.push('[' + role + '] ' + text)
    }
    if (picked.length === 0) return ''
    picked.reverse() // 时间正序
    // 总量预算:从最旧条目开始丢(设计文档裁剪阶梯)。
    let total = picked.reduce((s, x) => s + x.length, 0)
    while (picked.length > 1 && total > DIGEST_BUDGET) {
      total -= picked[0].length
      picked.shift()
    }
    return picked.join('\n\n').slice(0, DIGEST_BUDGET)
  }

  // ---------- 开场消息组装(§3.3,8K 裁剪阶梯) ----------
  function buildOpening(note, digest, statusText) {
    // 永不砍区:任务头 + 任务字段 + 来源上下文三层(存在的部分)。
    const neverCut = []
    neverCut.push('【便签任务】' + (note.note || '(空)'))

    let task = '## 任务\n'
    task += '- 下一步：' + (note.next || '(未设置)')
    task += '\n- 完成条件：' + (note.doneWhen || '(未设置，自行判断并在完成后说明)')
    neverCut.push(task)

    const ctx1 = ['## 来源上下文（来自会话高亮）']
    if (note.quote) ctx1.push('> 高亮原文：\n> ' + clampStr(note.quote, QUOTE_MAX).split('\n').join('\n> '))
    const ex = note.excerpt || {}
    if (ex.containing) ctx1.push('> 高亮所在消息（节选）：\n> ' + clampStr(ex.containing, 2000).split('\n').join('\n> '))
    if (ex.intent) ctx1.push('> 当时的提问：\n> ' + clampStr(ex.intent, EXCERPT_INTENT_CHARS).split('\n').join('\n> '))
    if (ctx1.length > 1) neverCut.push(ctx1.join('\n'))

    // 可裁区:先砍摘要,后砍 status(设计文档裁剪阶梯)。
    const tail = []
    if (digest) tail.push('## 来源会话尾声（便签创建前 30 分钟，节选）\n' + digest)
    if (statusText) tail.push('## 工作台当前状态\n' + statusText)

    let opening = '## 起手指示\n'
      + '你是一次（可能无人值守的）任务会话，以上是你的全部背景。第一步：用自己的话复述任务、'
      + '完成条件和已知结论，然后开始执行。若来源会话无法读取且上述背景不足以安全执行任务：'
      + '停下来，明确列出你缺什么信息，等待用户指示，不要靠猜测推进。'
      + (note.origin && note.origin.sessionId
        ? '需要更多上下文时可尝试读取来源会话 ' + note.origin.sessionId + '。'
        : '')

    let budget = OPENING_HARD_CAP - neverCut.join('\n\n').length - opening.length - 16
    const kept = []
    for (let i = 0; i < tail.length; i++) {
      if (budget <= 200) break
      const s = tail[i]
      kept.push(s.length > budget ? s.slice(0, budget) : s)
      budget -= s.length + 2
    }
    const full = [...neverCut, ...kept].join('\n\n') + '\n\n' + opening
    return full.length > OPENING_HARD_CAP ? full.slice(0, OPENING_HARD_CAP) : full
  }

  /** 当前 workspace 的状态便签正文(开场消息 §工作台当前状态)。 */
  const statusTextFor = (workspacePath) => {
    if (!workspacePath) return ''
    const st = cache.find((n) => n.kind === 'status' && n.workspacePath === workspacePath)
    return st ? st.note : ''
  }

  // ---------- spawn:便签 → 新会话(§2.1) ----------
  const spawnNote = async (id, opts) => {
    const auto = !!(opts && opts.auto)
    const note0 = findNote(id)
    if (!note0) throw new Error('note not found')
    if (note0.kind !== 'task') throw new Error('not a task note')
    if (!Array.isArray(note0.spawnLog)) note0.spawnLog = [] // legacy 数据防御
    const note = note0

    // 三段式第一段:意图态落盘(auto 路径;手动路径由调用方先清调度即可)。
    if (auto) {
      note.firedAt = nowIso()
      note.fireState = 'creating'
      await persist()
    }

    try {
      // 定位:workspacePath → 来源会话 cwd → 部署默认。
      let cwd = note.workspacePath || ''
      if (!cwd && note.origin && note.origin.sessionId) cwd = sessionCwds.get(note.origin.sessionId) || ''
      let workspaceId
      if (cwd) {
        try {
          const ws = await workspaceRegistry()?.resolveByPath(cwd)
          if (ws && ws.id) workspaceId = ws.id
        } catch (e) { console.warn('session-notes resolveByPath failed:', errText(e)) }
      }
      const digest = await buildDigest(note).catch(() => '')
      const opening = buildOpening(note, digest, statusTextFor(note.workspacePath))

      const sc = sessionController()
      if (!sc) throw new Error('sessionController unavailable')
      const created = await sc.create({
        ...(workspaceId ? { workspaceId } : (cwd ? { cwd } : {})),
        ...(note.preset ? { agentPreset: note.preset } : {}),
      })
      const sessionId = created && created.sessionId
      if (!sessionId) throw new Error('create returned no sessionId')

      await sc.prompt({
        requestId: 'snote-' + note.id + '-' + (note.firedAt || 'manual') + '-' + note.spawnLog.length,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: opening }],
      }, freshSignal())

      if (!note.spawnLog) note.spawnLog = []
      note.spawnLog.push({ sessionId, at: nowIso(), auto })
      note.fireState = 'fired'
      note.notifyDismissed = false
      if (!auto) {
        // 手动 spawn = 用户已行动:清掉调度,避免稍后 auto 重复开会话。
        note.dueAt = ''
        note.dueAction = 'auto'
        note.downgraded = false
      }
      await persist()
      return sessionId
    } catch (e) {
      if (auto) {
        note.fireState = 'failed'
        await persist().catch(() => {})
      }
      throw e
    }
  }

  // ---------- 调度器(§4) ----------
  let sweepBusy = false
  async function sweep() {
    if (sweepBusy) return
    sweepBusy = true
    try {
      const notes = await readAll()
      const now = Date.now()
      for (const note of notes) {
        if (note.kind !== 'task' || note.done || !note.dueAt || note.firedAt) continue
        if (Date.parse(note.dueAt) > now) continue
        const isAuto = note.dueAction !== 'notify' && !note.downgraded
        if (!isAuto) {
          // notify(或被降级):只落 firedAt 闩锁,面板亮角标等用户。
          note.firedAt = nowIso()
          await persist()
          continue
        }
        try {
          const sid = await spawnNote(note.id, { auto: true })
          console.log('session-notes auto-spawned', note.id, '→', sid)
        } catch (e) {
          console.error('session-notes auto-spawn failed for', note.id, errText(e))
        }
      }
    } finally { sweepBusy = false }
  }

  /** 崩溃恢复:'creating' 残留无 spawnLog → 标 failed(宁漏勿双,§2.1)。 */
  async function recoverInflight() {
    const notes = await readAll()
    let dirty = false
    for (const note of notes) {
      if (note.fireState === 'creating') {
        const stamped = (note.spawnLog || []).some((x) => x.at === note.firedAt)
        if (!stamped) { note.fireState = 'failed'; dirty = true }
        else { note.fireState = 'fired'; dirty = true }
      }
    }
    if (dirty) await persist()
  }

  // ---------- 来源会话检测(§5 T1) ----------
  let detectBusy = false
  async function detect() {
    if (detectBusy) return
    detectBusy = true
    try {
      const sc = sessionController()
      if (!sc) return
      const list = await sc.list()
      const items = list && Array.isArray(list.items) ? list.items : []
      const liveIds = new Set()
      const cwds = new Map()
      for (const it of items) {
        if (!it || !it.sessionId) continue
        liveIds.add(it.sessionId)
        if (typeof it.cwd === 'string' && it.cwd) cwds.set(it.sessionId, it.cwd)
      }
      sessionCwds = cwds
      let archivedIds = []
      try {
        const ids = workspaceRegistry()?.archivedSessionIds
        if (Array.isArray(ids)) archivedIds = ids
      } catch { /* registry absent */ }
      const notes = await readAll()
      let dirty = false
      for (const note of notes) {
        const originId = note.origin && note.origin.sessionId
        if (!originId) continue
        if (!liveIds.has(originId)) {
          if (!note.originLost) {
            note.originLost = nowIso()
            // T1 降级:未触发的 auto 任务转 notify,面板浮决策卡。
            if (note.kind === 'task' && note.dueAt && !note.firedAt && note.dueAction !== 'notify') {
              note.downgraded = true
            }
            dirty = true
            console.log('session-notes origin lost:', originId, 'note', note.id)
          }
        } else {
          const archived = archivedIds.includes(originId)
          if (!!note.originArchived !== archived) { note.originArchived = archived; dirty = true }
        }
      }
      if (dirty) await persist()
    } catch (e) {
      console.warn('session-notes detect failed:', errText(e))
    } finally { detectBusy = false }
  }

  const route = {
    kind: 'prefix',
    path: ROOT,
    handler: async (req, res) => {
      const u = new URL(req.url, 'http://x')
      const p = u.pathname.slice(ROOT.length)

      if (p === '/list' && req.method === 'GET') {
        try { return send(res, 200, { ok: true, notes: await readAll() }) }
        catch (e) { return send(res, 500, { ok: false, error: errText(e) }) }
      }

      if (req.method === 'POST') {
        if (!sameOrigin(req)) return send(res, 403, { ok: false, error: 'cross-origin request rejected' })
        const body = await read(req)
        if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
        try {
          if (p === '/diag') {
            console.log('session-notes diag:', JSON.stringify(body))
            return send(res, 200, { ok: true })
          }
          if (p === '/add') {
            const notes = await readAll()
            const now = nowIso()
            const originSessionId = String(body.sessionId || '')
            const kind = ['note', 'status', 'task'].includes(body.kind) ? body.kind : 'note'
            const note = {
              id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
              sessionId: String(body.sessionId || ''),
              workspacePath: String(body.workspacePath || ''),
              workspaceTitle: String(body.workspaceTitle || ''),
              quote: clampStr(body.quote, QUOTE_MAX),
              note: clampStr(body.note, NOTE_MAX),
              kind,
              origin: { sessionId: originSessionId, createdAt: now },
              createdAt: now,
              updatedAt: now,
            }
            if (kind === 'task') {
              note.next = clampStr(body.next, 1000)
              note.doneWhen = clampStr(body.doneWhen, 1000)
              note.done = false
              note.dueAt = validIso(body.dueAt) || ''
              note.dueAction = body.dueAction === 'notify' ? 'notify' : 'auto'
              note.preset = clampStr(body.preset, 200)
              note.spawnLog = []
            }
            // 三层捕获 + preset 捕获(best-effort,失败不阻塞保存)。
            try {
              if (originSessionId) {
                note.excerpt = await captureExcerpt(originSessionId)
                if (kind === 'task' && !note.preset) note.preset = capturePreset(originSessionId)
              }
            } catch (e) { console.warn('session-notes excerpt capture failed:', errText(e)) }
            if (kind === 'status' && note.workspacePath) {
              // 状态便签唯一活跃:同 workspace 旧 status 移除。
              for (let i = notes.length - 1; i >= 0; i--) {
                if (notes[i].kind === 'status' && notes[i].workspacePath === note.workspacePath) notes.splice(i, 1)
              }
            }
            notes.push(note)
            await persist()
            return send(res, 200, { ok: true, note })
          }
          if (p === '/update') {
            if (typeof body.id !== 'string') return send(res, 400, { ok: false, error: 'bad args' })
            const notes = await readAll()
            const target = notes.find((n) => n.id === body.id)
            if (!target) return send(res, 404, { ok: false, error: 'note not found' })
            if (typeof body.note === 'string') target.note = clampStr(body.note, NOTE_MAX)
            if (['note', 'status', 'task'].includes(body.kind)) {
              const prevKind = target.kind || 'note'
              target.kind = body.kind
              if (body.kind === 'task' && prevKind !== 'task') {
                if (!Array.isArray(target.spawnLog)) target.spawnLog = []
                if (typeof target.done !== 'boolean') target.done = false
                if (!target.dueAction) target.dueAction = 'auto'
                if (!target.origin) target.origin = { sessionId: target.sessionId || '', createdAt: target.createdAt }
              }
            }
            if (target.kind === 'task') {
              if (typeof body.next === 'string') target.next = clampStr(body.next, 1000)
              if (typeof body.doneWhen === 'string') target.doneWhen = clampStr(body.doneWhen, 1000)
              if (typeof body.done === 'boolean') {
                target.done = body.done
                // 勾完成时顺手清角标语义:调度本来就不触发 done 任务。
                if (body.done) target.notifyDismissed = false
              }
              if (body.dueAt === null || body.dueAt === '') { target.dueAt = '' }
              else if (validIso(body.dueAt)) {
                target.dueAt = body.dueAt
                target.firedAt = ''      // 新定时重置闩锁
                target.notifyDismissed = false
                target.fireState = ''
              }
              if (body.dueAction === 'auto' || body.dueAction === 'notify') {
                target.dueAction = body.dueAction
                if (body.dueAction === 'auto') target.downgraded = false
              }
              if (typeof body.preset === 'string') target.preset = clampStr(body.preset, 200)
              if (!target.preset && target.origin && target.origin.sessionId) {
                target.preset = capturePreset(target.origin.sessionId)
              }
            }
            target.updatedAt = nowIso()
            await persist()
            return send(res, 200, { ok: true, note: target })
          }
          if (p === '/status-set') {
            const workspacePath = String(body.workspacePath || '')
            if (!workspacePath) return send(res, 400, { ok: false, error: 'workspacePath required' })
            const notes = await readAll()
            let target = notes.find((n) => n.kind === 'status' && n.workspacePath === workspacePath)
            const now = nowIso()
            if (!target) {
              target = {
                id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
                sessionId: '',
                workspacePath,
                workspaceTitle: String(body.workspaceTitle || ''),
                quote: '',
                note: '',
                kind: 'status',
                origin: { sessionId: String(body.sessionId || ''), createdAt: now },
                createdAt: now,
                updatedAt: now,
              }
              notes.push(target)
            }
            target.note = clampStr(body.text, NOTE_MAX)
            target.updatedAt = now
            await persist()
            return send(res, 200, { ok: true, note: target })
          }
          if (p === '/spawn') {
            if (typeof body.id !== 'string') return send(res, 400, { ok: false, error: 'bad args' })
            const sessionId = await spawnNote(body.id, { auto: false })
            return send(res, 200, { ok: true, sessionId })
          }
          if (p === '/ack') {
            if (typeof body.id !== 'string' || typeof body.action !== 'string') return send(res, 400, { ok: false, error: 'bad args' })
            const notes = await readAll()
            const target = notes.find((n) => n.id === body.id)
            if (!target) return send(res, 404, { ok: false, error: 'note not found' })
            if (body.action === 'dismiss') {
              target.notifyDismissed = true
            } else if (body.action === 'restore-auto') {
              target.downgraded = false
              target.dueAction = 'auto'
            } else if (body.action === 'cancel-due') {
              target.dueAt = ''
              target.firedAt = ''
              target.fireState = ''
              target.downgraded = false
              target.notifyDismissed = true
            } else {
              return send(res, 400, { ok: false, error: 'unknown action' })
            }
            target.updatedAt = nowIso()
            await persist()
            return send(res, 200, { ok: true, note: target })
          }
          if (p === '/delete') {
            if (typeof body.id !== 'string') return send(res, 400, { ok: false, error: 'bad args' })
            const notes = await readAll()
            const idx = notes.findIndex((n) => n.id === body.id)
            if (idx === -1) return send(res, 404, { ok: false, error: 'note not found' })
            notes.splice(idx, 1)
            await persist()
            return send(res, 200, { ok: true })
          }
          return send(res, 404, { ok: false, error: 'not found' })
        } catch (e) {
          console.error('session-notes api error:', errText(e))
          return send(res, 500, { ok: false, error: errText(e) })
        }
      }

      return send(res, 404, { ok: false, error: 'not found' })
    },
  }

  const disposers = [ctx.webServer.register(route)]

  // 调度器 + 检测:启动序 = 恢复残留 → 检测(先降级) → sweep(过期补射)。
  const sweepTimer = setInterval(() => { sweep().catch(() => {}) }, SWEEP_INTERVAL_MS)
  const detectTimer = setInterval(() => { detect().catch(() => {}) }, DETECT_INTERVAL_MS)
  const boot = (async () => {
    try {
      await recoverInflight()
      await detect()
      await sweep()
    } catch (e) { console.warn('session-notes boot pass failed:', errText(e)) }
  })()

  // cordis ctx.effect:setup runs immediately, its RETURN VALUE is the disposer —
  // single-layer arrow would dispose the route right after registering it.
  ctx.effect(() => () => {
    clearInterval(sweepTimer)
    clearInterval(detectTimer)
    for (const d of disposers) {
      try { d() } catch { /* noop */ }
    }
    disposers.length = 0
  }, 'dsh-session-notes: route + scheduler cleanup')
}

function validIso(v) {
  if (typeof v !== 'string' || !v) return ''
  const t = Date.parse(v)
  return Number.isFinite(t) ? v : ''
}
