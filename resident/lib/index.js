// dsh-session-notes — 节点半边:便签 JSON 存储 + 同源 API(/session-notes/api/*)。
//
// 存储:~/.dsh/storages/session-notes/notes.json(fs 服务原子写,shell cat 兜底,
// 写队列失败隔离)。对**自己的存储文件**按调用声明 danger-full-access 沙箱策略:
// 部署默认的 workspace-write 围栏不含 $DSH_HOME,不声明会被拒(Operation not
// permitted)。除此之外不触碰任何路径。
// API(同源门:写操作校验 Sec-Fetch-Site/Origin):
//   GET  /list                → {ok, notes}
//   POST /add    {sessionId, workspacePath, workspaceTitle, quote, note} → {ok, note}
//   POST /update {id, note}   → {ok, note}
//   POST /delete {id}         → {ok}
//   POST /diag   {key, ...}   → {ok}(诊断落 dsh-web.log)

export const inject = ['webServer', 'fs', 'shell']

const ROOT = '/session-notes/api'
const POLICY = { mode: 'danger-full-access', workspaceRoot: '' }

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
  const fs = ctx.fs
  const shell = ctx.shell

  let storeReady = null
  let cache = null
  let queue = Promise.resolve()

  function ensureStore() {
    if (storeReady !== null) return storeReady
    storeReady = (async () => {
      const spec = shell.resolve({
        command: 'd="${DSH_HOME:-$HOME/.dsh}"; mkdir -p "$d/storages/session-notes" && printf %s "$d"',
        sandboxPolicy: POLICY,
      })
      const res = await shell.run(spec)
      if (res.exitCode !== 0) {
        throw new Error('discover dsh home failed: ' + ((res.stderr && res.stderr.text) || ('exit ' + res.exitCode)))
      }
      const base = ((res.stdout && res.stdout.text) || '').trim()
      if (!base || base.charAt(0) !== '/') throw new Error('unexpected dsh home: ' + base)
      const file = base + '/storages/session-notes/notes.json'
      console.log('session-notes store at', file)
      return { file }
    })()
    return storeReady
  }

  async function readRaw(file) {
    try {
      const target = await fs.resolve(file)
      return await fs.readText(target)
    } catch (e) {
      console.error('session-notes fs.readText failed:', errText(e), '— trying shell read')
    }
    const spec = shell.resolve({ command: 'cat "$SNOTE_FILE" 2>/dev/null || true', env: { SNOTE_FILE: file }, sandboxPolicy: POLICY })
    const res = await shell.run(spec)
    if (res.exitCode !== 0) throw new Error('shell read failed: exit ' + res.exitCode)
    return (res.stdout && res.stdout.text) || ''
  }

  async function writeRaw(file, content) {
    try {
      const target = await fs.resolve(file)
      await fs.writeText(target, content, undefined, undefined, POLICY)
      return
    } catch (e) {
      console.error('session-notes fs.writeText failed:', errText(e), '— trying shell write')
    }
    const spec = shell.resolve({ command: 'cat > "$SNOTE_FILE"', env: { SNOTE_FILE: file }, stdin: content, sandboxPolicy: POLICY })
    const res = await shell.run(spec)
    if (res.exitCode !== 0) {
      throw new Error('shell write failed (exit ' + res.exitCode + '): ' + ((res.stderr && res.stderr.text) || '').slice(0, 300))
    }
  }

  async function readAll() {
    if (cache !== null) return cache
    const { file } = await ensureStore()
    const text = await readRaw(file)
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

  function persist() {
    const attempt = queue.then(async () => {
      const { file } = await ensureStore()
      await writeRaw(file, JSON.stringify(cache, null, 2))
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

      // 写操作:解析 JSON + 同源门
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
  ctx.effect(() => {
    for (const d of disposers) {
      try { d() } catch { /* noop */ }
    }
  })
}
