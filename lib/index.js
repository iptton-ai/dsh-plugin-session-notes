// dsh-session-notes — 节点半边:便签 JSON 存储 + 同源 API(/session-notes/api/*)。
//
// 常驻形态(profile 插件)直接使用 Node 内置 API——web 壳组合不提供 fs/shell
// 服务(那些挂在 agent 会话域),而本插件在产品信任域内,与 dsh-grok-media 等
// 常驻插件同级,不受文件沙箱围栏约束。
//
// 存储:~/.dsh/storages/session-notes/notes.json(temp+rename 原子写,写队列
// 失败隔离)。
// API(写操作带同源门):
//   GET  /list                → {ok, notes}
//   POST /add    {sessionId, workspacePath, workspaceTitle, quote, note} → {ok, note}
//   POST /update {id, note}   → {ok, note}
//   POST /delete {id}         → {ok}
//   POST /diag   {key, ...}   → {ok}(诊断落 dsh-web.log)

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const inject = ['webServer']

const ROOT = '/session-notes/api'

const errText = (e) => String((e && e.message) || e)

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

export function apply(ctx) {
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const file = join(dshHome, 'storages', 'session-notes', 'notes.json')
  console.log('session-notes store at', file)

  let cache = null
  let queue = Promise.resolve()

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
            const now = new Date().toISOString()
            const note = {
              id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
              sessionId: String(body.sessionId || ''),
              workspacePath: String(body.workspacePath || ''),
              workspaceTitle: String(body.workspaceTitle || ''),
              quote: String(body.quote || '').slice(0, 2000),
              note: String(body.note || '').slice(0, 4000),
              createdAt: now,
              updatedAt: now,
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
            if (typeof body.note === 'string') target.note = body.note.slice(0, 4000)
            target.updatedAt = new Date().toISOString()
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
  // cordis ctx.effect:setup runs immediately, its RETURN VALUE is the disposer —
  // single-layer arrow would dispose the route right after registering it.
  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch { /* noop */ }
    }
    disposers.length = 0
  }, 'dsh-session-notes: route cleanup')
}
