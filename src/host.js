return {
  apply(ctx) {
    const shell = ctx.get('shell')
    const fs = ctx.get('fs')
    if (shell === undefined || fs === undefined) {
      console.error('session-notes host: fs/shell service missing; note RPC will fail until they appear')
    }

    const errText = (e) => String((e && e.message) || e)

    const POLICY = { mode: 'danger-full-access', workspaceRoot: '' }

    let storeReady = null
    let cache = null
    let queue = Promise.resolve()

    function ensureStore() {
      if (storeReady !== null) return storeReady
      storeReady = (async () => {
        if (shell === undefined || fs === undefined) throw new Error('fs/shell services unavailable in this host')
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
      } catch (e) { arr = [] }
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

    const fail = (message) => ({ ok: false, error: String(message) })
    const msg = (e) => String((e && e.message) || e)

    ctx.effect(() => harness.handle('notes/diag', async (args) => {
      try {
        console.log('session-notes diag:', JSON.stringify(args))
        return { ok: true }
      } catch (e) { return fail(msg(e)) }
    }))

    ctx.effect(() => harness.handle('notes/list', async () => {
      try { return { ok: true, notes: await readAll() } }
      catch (e) { console.error('session-notes list error:', errText(e)); return fail(msg(e)) }
    }))

    ctx.effect(() => harness.handle('notes/add', async (args) => {
      try {
        if (!args || typeof args !== 'object') return fail('bad args')
        const notes = await readAll()
        const now = new Date().toISOString()
        const note = {
          id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          sessionId: String(args.sessionId || ''),
          workspacePath: String(args.workspacePath || ''),
          workspaceTitle: String(args.workspaceTitle || ''),
          quote: String(args.quote || '').slice(0, 2000),
          note: String(args.note || '').slice(0, 4000),
          createdAt: now,
          updatedAt: now,
        }
        notes.push(note)
        await persist()
        return { ok: true, note }
      } catch (e) { console.error('session-notes add error:', errText(e)); return fail(msg(e)) }
    }))

    ctx.effect(() => harness.handle('notes/update', async (args) => {
      try {
        if (!args || typeof args.id !== 'string') return fail('bad args')
        const notes = await readAll()
        const target = notes.find((n) => n.id === args.id)
        if (!target) return fail('note not found')
        if (typeof args.note === 'string') target.note = args.note.slice(0, 4000)
        target.updatedAt = new Date().toISOString()
        await persist()
        return { ok: true, note: target }
      } catch (e) { console.error('session-notes update error:', errText(e)); return fail(msg(e)) }
    }))

    ctx.effect(() => harness.handle('notes/delete', async (args) => {
      try {
        if (!args || typeof args.id !== 'string') return fail('bad args')
        const notes = await readAll()
        const idx = notes.findIndex((n) => n.id === args.id)
        if (idx === -1) return fail('note not found')
        notes.splice(idx, 1)
        await persist()
        return { ok: true }
      } catch (e) { console.error('session-notes delete error:', errText(e)); return fail(msg(e)) }
    }))
  },
}
