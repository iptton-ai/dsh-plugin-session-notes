// dsh-session-notes — 浏览器半边(常驻模块):划线引擎 + 面板/弹窗/选区 UI
//                               + 任务/状态便签 + 定时 spawn 联动。
// 由动态 Cordis 包(snote-1/pkg-13)翻译而来:RPC 改走同源 /session-notes/api/*,
// timer/styles 改为原生实现;其余逻辑(间隙感知匹配、CSS Custom Highlight API、
// 5s 对账自愈)与动态版逐行一致。任务/调度/spawn 仅常驻形态可用(设计文档
// docs/design-working-loop.md)。
window.__ModuleLoader__.load({
  id: 'dsh-session-notes',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')

    // ---- runtime helpers (timers / styles / api) ----
    const timers = new Set()
    const snTimeout = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn() }, ms); timers.add(t); return t }
    const snInterval = (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t }
    const snDebounce = (fn, ms) => {
      let t = null
      const wrapped = (...a) => { if (t) clearTimeout(t); t = snTimeout(() => { t = null; fn(...a) }, ms) }
      return wrapped
    }
    const clearAllTimers = () => { for (const t of timers) { clearTimeout(t); clearInterval(t) } timers.clear() }

    let styleDisposer = null
    const snInsertStyles = (css) => {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-session-notes'
      tag.textContent = css
      document.head.appendChild(tag)
      styleDisposer = () => { tag.remove() }
    }

    const api = async (path, payload) => {
      const init = payload !== undefined
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
        : { headers: { accept: 'application/json' } }
      try {
        const res = await fetch('/session-notes/api' + path, init)
        return await res.json()
      } catch (e) { return { ok: false, error: String(e) } }
    }

    const apply = (ctx) => {
    const slots = ctx.slots

    // ---------- shared store (closure-scoped, shared by all slot entries) ----------
    const S = {
      notes: [], loaded: false, error: null,
      sessionId: null, workspacePath: null, workspaceTitle: null,
      inputActions: null, draftText: '',
      panelOpen: false, filter: 'all',
      sel: null, editing: null, toast: null,
      spawning: null,
    }
    const listeners = new Set()
    const emit = () => { for (const fn of Array.from(listeners)) { try { fn() } catch (e) {} } }
    const useStore = () => {
      const force = React.useState(0)[1]
      React.useEffect(() => {
        const fn = () => force((v) => v + 1)
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      }, [])
      return S
    }

    const showToast = (text, ms) => {
      S.toast = text
      emit()
      snTimeout(() => { if (S.toast === text) { S.toast = null; emit() } }, ms || 2400)
    }
    const showErr = (prefix, e) => {
      showToast(prefix + ': ' + String((e && e.message) || e || ''), 6000)
    }

    const clearBrowserSelection = () => {
      try { const sel = window.getSelection(); if (sel) sel.removeAllRanges() } catch (e) {}
    }

    let lastDiagKey = ''
    const diag = (key, data) => {
      if (key === lastDiagKey) return
      lastDiagKey = key
      void api('/diag', Object.assign({ key }, data))
    }

    const replaceNote = (note) => {
      const i = S.notes.findIndex((x) => x.id === note.id)
      if (i >= 0) S.notes[i] = note; else S.notes.push(note)
    }

    // ---------- host RPC ----------
    const loadNotes = async () => {
      try {
        const res = await api('/list')
        if (res && res.ok) { S.notes = Array.isArray(res.notes) ? res.notes : []; S.loaded = true; S.error = null }
        else S.error = (res && res.error) || 'load failed'
      } catch (e) { S.error = String(e) }
      emit()
      applyAll()
    }
    const addNoteRpc = async (payload) => {
      const res = await api('/add', payload)
      if (res && res.ok) {
        if (res.note.kind === 'status') {
          // 状态便签替换语义:去掉同 workspace 的旧 status。
          S.notes = S.notes.filter((x) => !(x.kind === 'status' && x.workspacePath === res.note.workspacePath))
        }
        S.notes.push(res.note); emit(); applyAll(); return res.note
      }
      throw new Error((res && res.error) || 'unknown')
    }
    const addNote = async (quote, text) => {
      try {
        const note = await addNoteRpc({
          sessionId: S.sessionId || '', workspacePath: S.workspacePath || '',
          workspaceTitle: S.workspaceTitle || '', quote: quote, note: text,
        })
        showToast('已记便签 ✓')
        return note
      } catch (e) { showErr('保存失败', e); return null }
    }
    const addManualNote = async (scope, quote, text, extra) => {
      try {
        const payload = Object.assign({ quote: quote, note: text, workspaceTitle: S.workspaceTitle || '' }, extra || {})
        if (scope === 'session') { payload.sessionId = S.sessionId || ''; payload.workspacePath = S.workspacePath || '' }
        else if (scope === 'workspace') { payload.sessionId = ''; payload.workspacePath = S.workspacePath || '' }
        else { payload.sessionId = ''; payload.workspacePath = '' }
        if (payload.kind === 'status') {
          // 状态便签:强制 workspace 归属(无 workspace 则退化为普通便签)。
          if (S.workspacePath) { payload.sessionId = ''; payload.workspacePath = S.workspacePath }
          else { payload.kind = 'note'; showToast('当前无目录,状态便签需要目录归属,已存为全局便签') }
        }
        if (scope === 'session' && !S.sessionId && payload.kind !== 'status') { showToast('当前没有打开的会话,已存为全局便签') }
        const note = await addNoteRpc(payload)
        showToast(payload.kind === 'status' ? '已更新当前状态 ✓' : payload.kind === 'task' ? '已建任务 ✓' : '已新建便签 ✓')
        return note
      } catch (e) { showErr('保存失败', e); return null }
    }
    // 从选区记任务(记便签弹窗里把类型切到「任务」)。
    const addTaskFromSelection = async (quote, text, extra) => {
      try {
        const note = await addNoteRpc(Object.assign({
          sessionId: S.sessionId || '', workspacePath: S.workspacePath || '',
          workspaceTitle: S.workspaceTitle || '', quote, note: text,
        }, extra || {}))
        showToast('已建任务 ✓')
        return note
      } catch (e) { showErr('保存失败', e); return null }
    }
    const updateNote = async (id, text) => {
      try {
        const res = await api('/update', { id, note: text })
        if (res && res.ok) {
          replaceNote(res.note)
          emit(); applyAll(); showToast('已更新 ✓')
          return res.note
        }
        showErr('更新失败', (res && res.error) || new Error('unknown'))
        return null
      } catch (e) { showErr('更新失败', e); return null }
    }
    const updateTask = async (id, patch) => {
      try {
        const res = await api('/update', Object.assign({ id }, patch))
        if (res && res.ok) { replaceNote(res.note); emit(); applyAll(); return res.note }
        showErr('更新失败', (res && res.error) || new Error('unknown'))
        return null
      } catch (e) { showErr('更新失败', e); return null }
    }
    const statusSet = async (text) => {
      try {
        const res = await api('/status-set', {
          workspacePath: S.workspacePath || '', workspaceTitle: S.workspaceTitle || '',
          sessionId: S.sessionId || '', text,
        })
        if (res && res.ok) { replaceNote(res.note); emit(); showToast('已更新当前状态 ✓'); return res.note }
        showErr('保存失败', (res && res.error) || new Error('unknown'))
        return null
      } catch (e) { showErr('保存失败', e); return null }
    }
    const ackNote = async (id, action) => {
      try {
        const res = await api('/ack', { id, action })
        if (res && res.ok) { if (res.note) replaceNote(res.note); emit(); return true }
        showErr('操作失败', (res && res.error) || new Error('unknown'))
        return false
      } catch (e) { showErr('操作失败', e); return false }
    }
    const openSession = (sessionId) => {
      // dsh >= 0.1.6-alpha.2: ISessions.open 已移除(客户端 Session 所有权重构,
      // 导航归 view owners),会话跳转改走 uiWorkspace 服务的 openSession;
      // 旧版 sessions.open 保留为兜底。
      try {
        const uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
        if (uiWorkspace && typeof uiWorkspace.openSession === 'function') { uiWorkspace.openSession(sessionId); return true }
      } catch (e) {}
      try {
        const sessions = ctx.sessions
        if (sessions && typeof sessions.open === 'function') { sessions.open(sessionId); return true }
      } catch (e) {}
      return false
    }
    const spawnTask = async (id) => {
      if (S.spawning) { showToast('正在开新会话…'); return null }
      S.spawning = id; emit()
      try {
        const res = await api('/spawn', { id })
        if (res && res.ok && res.sessionId) {
          showToast('已开新会话 ✓')
          loadNotes()
          snTimeout(() => { if (!openSession(res.sessionId)) showToast('新会话: ' + String(res.sessionId).slice(0, 18) + '…(侧栏查看)', 5000) }, 350)
          return res.sessionId
        }
        showErr('开新会话失败', (res && res.error) || new Error('unknown'))
        return null
      } catch (e) { showErr('开新会话失败', e); return null }
      finally { S.spawning = null; emit() }
    }
    const deleteNote = async (id) => {
      try {
        const res = await api('/delete', { id })
        if (res && res.ok) {
          S.notes = S.notes.filter((x) => x.id !== id)
          emit(); applyAll(); showToast('已删除')
        } else showErr('删除失败', (res && res.error) || new Error('unknown'))
      } catch (e) { showErr('删除失败', e) }
    }

    const sendToComposer = (n) => {
      const actions = S.inputActions
      if (!actions || typeof actions.setDraft !== 'function') { showToast('当前没有可用的输入框', 3600); return false }
      const parts = []
      if (n.note) parts.push(n.note)
      if (n.quote) parts.push('> ' + n.quote)
      const text = parts.join('\n\n')
      const draft = S.draftText || ''
      try {
        actions.setDraft(draft ? draft + '\n\n' + text : text)
        showToast('已追加到对话框 ✓')
        return true
      } catch (e) { showErr('插入失败', e); return false }
    }

    // ---------- highlight engine ----------
    const supportsHighlight = typeof Highlight !== 'undefined'
      && typeof CSS !== 'undefined' && CSS.highlights !== undefined && CSS.highlights !== null

    let container = null
    let mo = null
    let noteRanges = []
    const reapply = snDebounce(() => { applyAll() }, 400)

    const findScrollParent = (el) => {
      let node = el
      while (node && node.nodeType === 1) {
        if (node === document.body || node === document.documentElement) return null
        const style = window.getComputedStyle(node)
        const oy = style.overflowY
        if ((oy === 'auto' || oy === 'scroll') && node.clientHeight > 120) return node
        node = node.parentNode
      }
      return null
    }

    const observeContainer = () => {
      if (mo || !container) return
      mo = new MutationObserver(() => { reapply() })
      mo.observe(container, { childList: true, subtree: true, characterData: true })
    }

    const registerContainer = (el) => {
      if (el === container) return
      if (mo) { mo.disconnect(); mo = null }
      container = el
      observeContainer()
    }

    const collectTextNodes = (root) => {
      const nodes = []
      const walk = (node) => {
        for (let n = node.firstChild; n; n = n.nextSibling) {
          if (n.nodeType === 3) {
            if (n.nodeValue && n.nodeValue.trim().length > 0) nodes.push(n)
          } else if (n.nodeType === 1) {
            const tag = n.tagName
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT') continue
            if (n.hasAttribute && n.hasAttribute('data-snote-ui')) continue
            walk(n)
          }
        }
      }
      walk(root)
      return nodes
    }

    // ---------- gap-aware full-text assembly (matches Selection.toString semantics) ----------
    const BLOCK_TAGS = { P: 1, DIV: 1, LI: 1, UL: 1, OL: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1, PRE: 1, BLOCKQUOTE: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HR: 1, SECTION: 1, ARTICLE: 1, ASIDE: 1, HEADER: 1, FOOTER: 1, FIGURE: 1, DL: 1, DT: 1, DD: 1, DETAILS: 1, SUMMARY: 1 }

    const nearestBlock = (node) => {
      let n = node.parentNode
      while (n && n.nodeType === 1 && n !== document.body) {
        if (BLOCK_TAGS[n.tagName]) return n
        n = n.parentNode
      }
      return null
    }

    const subtreeHasBr = (node) => {
      if (node.nodeType === 1) {
        if (node.tagName === 'BR') return true
        for (let c = node.firstChild; c; c = c.nextSibling) if (subtreeHasBr(c)) return true
      }
      return false
    }

    // true when a visual line break sits between DOM-adjacent collected nodes a and b
    const hasBreakBetween = (a, b) => {
      const chain = new Set()
      let n = a
      while (n) { chain.add(n); n = n.parentNode }
      let lca = b
      while (lca && !chain.has(lca)) lca = lca.parentNode
      if (!lca) return true
      n = a
      while (n !== lca) {
        let s = n.nextSibling
        while (s) { if (subtreeHasBr(s)) return true; s = s.nextSibling }
        n = n.parentNode
      }
      n = b
      while (n !== lca) {
        let s = n.previousSibling
        while (s) { if (subtreeHasBr(s)) return true; s = s.previousSibling }
        n = n.parentNode
      }
      return false
    }

    const gapRange = document.createRange()
    // the gap text the browser itself would surface between two adjacent collected nodes:
    // '\n' across block/br boundaries, verbatim whitespace nodes inline, '' when truly adjacent
    const gapBetween = (prev, cur) => {
      if (nearestBlock(prev) !== nearestBlock(cur)) return '\n'
      if (hasBreakBetween(prev, cur)) return '\n'
      try {
        gapRange.setStart(prev, prev.nodeValue.length)
        gapRange.setEnd(cur, 0)
        const t = gapRange.toString()
        return t // '' when inline-adjacent; whitespace when skipped whitespace nodes sit between
      } catch (e) { return '\n' }
    }

    const foldWs = (s) => {
      let out = ''
      const map = []
      let i = 0
      while (i < s.length) {
        const ch = s.charAt(i)
        if (/[\s\u00a0]/.test(ch)) {
          let j = i
          while (j < s.length && /[\s\u00a0]/.test(s.charAt(j))) j++
          out += ' '
          map.push(i)
          i = j
        } else {
          out += ch
          map.push(i)
          i++
        }
      }
      return { text: out, map }
    }

    const clearMarkHighlights = () => {
      if (!container) return
      const marks = container.querySelectorAll('mark.snote-mark')
      for (let i = 0; i < marks.length; i++) {
        const m = marks[i]
        const parent = m.parentNode
        if (!parent) continue
        while (m.firstChild) parent.insertBefore(m.firstChild, m)
        parent.removeChild(m)
        if (parent.normalize) parent.normalize()
      }
    }

    const clearApiHighlights = () => {
      noteRanges = []
      try {
        for (const key of Array.from(CSS.highlights.keys())) {
          if (key.indexOf('snote-') === 0) CSS.highlights.delete(key)
        }
      } catch (e) {}
    }

    const wrapOrigin = (spans, origStart, origEnd, note, stats) => {
      for (let i = 0; i < spans.length; i++) {
        try {
          const sp = spans[i]
          const node = sp.node
          if (!node.parentNode) continue
          const len = node.nodeValue.length
          const nodeStart = sp.start
          const nodeEnd = nodeStart + len
          if (nodeEnd <= origStart || nodeStart >= origEnd) continue
          const s = Math.max(0, origStart - nodeStart)
          const e = Math.min(len, origEnd - nodeStart)
          let target = node
          if (e < len) target.splitText(e)
          let inner = target
          if (s > 0) inner = target.splitText(s)
          const mark = document.createElement('mark')
          mark.className = 'snote-mark'
          mark.setAttribute('data-snote-id', note.id)
          mark.setAttribute('title', (note.note || '').slice(0, 140))
          const parent = inner.parentNode
          parent.insertBefore(mark, inner)
          mark.appendChild(inner)
          stats.wrapped += 1
        } catch (e) { stats.errors += 1 }
      }
    }

    function applyAll() {
      if (!container) { diag('no-container', {}); return }
      if (mo) { mo.disconnect(); mo = null }
      const stats = { mine: 0, hit: 0, wrapped: 0, errors: 0 }
      const restoreObserver = () => {
        window.setTimeout(function () {
          try { observeContainer() } catch (e) {}
        }, 60)
      }
      try {
        if (supportsHighlight) clearApiHighlights()
        clearMarkHighlights()
        const sid = S.sessionId
        if (!sid) { diag('no-session', {}); restoreObserver(); return }
        const mine = S.notes.filter((n) => n.sessionId === sid && n.quote && n.quote.trim().length > 1)
        stats.mine = mine.length
        if (mine.length === 0) { restoreObserver(); return }
        const nodes = collectTextNodes(container)
        if (nodes.length === 0) { diag('no-text-nodes', { mine: mine.length }); restoreObserver(); return }
        let full = ''
        const spans = []
        for (let i = 0; i < nodes.length; i++) {
          if (i > 0) full += gapBetween(nodes[i - 1], nodes[i])
          spans.push({ node: nodes[i], start: full.length })
          full += nodes[i].nodeValue
        }
        const folded = foldWs(full)
        const ranges = []
        for (let k = 0; k < mine.length; k++) {
          const note = mine[k]
          const q = foldWs(note.quote.trim()).text
          if (!q) continue
          const at = folded.text.indexOf(q)
          if (at === -1) continue
          stats.hit += 1
          const origStart = folded.map[at]
          const origEnd = folded.map[at + q.length - 1] + 1
          if (supportsHighlight) {
            let startNode = null
            let startOff = 0
            let endNode = null
            let endOff = 0
            for (let i = 0; i < spans.length; i++) {
              const sp = spans[i]
              const nodeLen = sp.node.nodeValue.length
              const nodeStart = sp.start
              const nodeEnd = nodeStart + nodeLen
              if (nodeEnd <= origStart || nodeStart >= origEnd) continue
              if (startNode === null) { startNode = sp.node; startOff = Math.max(0, origStart - nodeStart) }
              endNode = sp.node
              endOff = Math.min(nodeLen, origEnd - nodeStart)
            }
            if (startNode !== null && endNode !== null) {
              try {
                const range = document.createRange()
                range.setStart(startNode, startOff)
                range.setEnd(endNode, endOff)
                ranges.push({ id: note.id, range })
                stats.wrapped += 1
              } catch (e) { stats.errors += 1 }
            }
          } else {
            wrapOrigin(spans, origStart, origEnd, note, stats)
          }
        }
        if (supportsHighlight && ranges.length > 0) {
          try {
            const group = new Highlight()
            for (let i = 0; i < ranges.length; i++) group.add(ranges[i].range)
            CSS.highlights.set('snote-hl', group)
            noteRanges = ranges
          } catch (e) { diag('highlight-register-failed', { error: String(e) }) }
        }
        if (stats.hit === 0) diag('no-hit', { mine: mine.length, sample: mine[0].quote.slice(0, 60) })
      } finally {
        restoreObserver()
      }
      if (stats.wrapped > 0 || stats.errors > 0) diag('applied:' + stats.mine + '/' + stats.hit + '/' + stats.wrapped + '/' + stats.errors + (supportsHighlight ? '/api' : '/mark'), stats)
    }

    snInterval(function () {
      if (!container) return
      const sid = S.sessionId
      const mine = sid ? S.notes.filter(function (n) { return n.sessionId === sid && n.quote && n.quote.trim().length > 1 }).length : 0
      if (supportsHighlight) {
        let alive = 0
        for (let i = 0; i < noteRanges.length; i++) {
          const sc = noteRanges[i].range.startContainer
          if (sc && sc.isConnected) alive += 1
        }
        if (mine !== alive) applyAll()
      } else {
        const have = container.querySelectorAll('mark.snote-mark').length
        if (mine !== have) applyAll()
      }
    }, 5000)

    // 轻轮询:auto-spawn 结果、角标、检测降级自动浮现(设计文档 §6)。
    snInterval(function () {
      if (S.loaded && (S.panelOpen || S.notes.some((n) => n.kind === 'task'))) loadNotes()
    }, 25000)

    const rangeAlive = (nr) => {
      try { return nr.range.startContainer && nr.range.startContainer.isConnected } catch (e) { return false }
    }

    const revealNote = (id) => {
      if (!container) { showToast('消息区未就绪'); return }
      applyAll()
      if (supportsHighlight) {
        const nr = noteRanges.find((x) => x.id === id)
        if (!nr || !rangeAlive(nr)) { showToast('未找到划线文本(消息可能未加载)', 3600); return }
        const el = nr.range.startContainer.parentElement
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch (e) { el.scrollIntoView() }
        return
      }
      const cssEscape = (s) => ((window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'))
      const mark = container.querySelector('mark.snote-mark[data-snote-id="' + cssEscape(id) + '"]')
      if (!mark) { showToast('未找到划线文本(消息可能未加载)', 3600); return }
      try { mark.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch (e) { mark.scrollIntoView() }
      mark.classList.remove('snote-flash')
      void mark.offsetWidth
      mark.classList.add('snote-flash')
    }

    const handleSelectionChange = () => {
      try {
        const sel = window.getSelection()
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
          if (S.sel) { S.sel = null; emit() }
          return
        }
        const range = sel.getRangeAt(0)
        const common = range.commonAncestorContainer
        const commonEl = common.nodeType === 1 ? common : common.parentNode
        if (!container || !commonEl || !container.contains(commonEl)) {
          if (S.sel) { S.sel = null; emit() }
          return
        }
        const text = sel.toString()
        const trimmed = text.replace(/\s+/g, ' ').trim()
        if (trimmed.length < 2) return
        const rect = range.getBoundingClientRect()
        S.sel = { x: rect.left + rect.width / 2, y: rect.top, quote: trimmed }
        emit()
      } catch (e) {}
    }

    const openView = (id) => {
      const n = S.notes.find((x) => x.id === id)
      if (n) { S.editing = { mode: 'view', id: n.id, quote: n.quote, text: n.note, noteObj: n }; emit() }
    }

    // ---------- task helpers ----------
    const toLocalInput = (iso) => {
      if (!iso) return ''
      const d = new Date(iso)
      if (isNaN(d.getTime())) return ''
      const p = (v) => (v < 10 ? '0' : '') + v
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes())
    }
    const fromLocalInput = (v) => {
      if (!v) return ''
      const t = new Date(v)
      return isNaN(t.getTime()) ? '' : t.toISOString()
    }
    const quickDue = (kind) => {
      const d = new Date()
      if (kind === 'morning') {
        d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0)
      } else {
        d.setTime(d.getTime() + 5 * 3600_000)
      }
      return toLocalInput(d.toISOString())
    }
    /** 任务调度徽标(设计文档 §6)。 */
    const taskDueBadge = (n) => {
      if (!n || n.kind !== 'task') return null
      if (n.fireState === 'failed') return { cls: 'snote-badge-fail', text: '启动失败·可重试' }
      if (n.done) return null
      if (n.dueAt && !n.firedAt) {
        if (n.originLost && n.downgraded) return { cls: 'snote-badge-warn', text: '来源会话已删·降级为提醒' }
        if (Date.parse(n.dueAt) > Date.now()) return { cls: 'snote-badge-info', text: '定时 ' + fmtTime(n.dueAt) + (n.dueAction === 'notify' ? ' · 仅提醒' : ' · 自动开跑') }
        return { cls: 'snote-badge-info', text: '待触发' }
      }
      if (n.firedAt && !n.notifyDismissed && !(n.spawnLog || []).length) return { cls: 'snote-badge-warn', text: '到点待处理' }
      if ((n.spawnLog || []).length) {
        const last = n.spawnLog[n.spawnLog.length - 1]
        return { cls: 'snote-badge-ok', text: (last.auto ? '自动' : '已') + '开跑 ' + fmtTime(last.at) }
      }
      return null
    }

    // ---------- components ----------
    const Anchor = (props) => {
      const ref = React.useRef(null)
      const sessionId = props.sessionId
      const ws = typeof props.useWorkspaces === 'function'
        ? props.useWorkspaces(function (snap) { return snap })
        : undefined
      const draftText = typeof props.useInput === 'function'
        ? props.useInput(function (st) { return (st && st.draft) || '' })
        : ''

      S.draftText = draftText

      React.useEffect(() => {
        S.inputActions = props.inputActions || null
      }, [props.inputActions])

      React.useEffect(() => {
        S.sessionId = sessionId || null
        let path = null
        let title = null
        if (ws && ws.items && sessionId) {
          for (let i = 0; i < ws.items.length; i++) {
            const w = ws.items[i]
            if (w.sessionIds && w.sessionIds.indexOf(sessionId) !== -1) { path = w.path; title = w.title; break }
          }
        }
        S.workspacePath = path
        S.workspaceTitle = title
        emit()
        applyAll()
      }, [sessionId, ws])

      React.useEffect(() => {
        const el = ref.current
        if (!el) return undefined
        let tries = 0
        let done = false
        const tryInstall = () => {
          if (done) return
          const c = findScrollParent(el)
          if (c) { done = true; registerContainer(c); applyAll(); return }
          if (tries++ < 30) window.requestAnimationFrame(tryInstall)
        }
        tryInstall()
        return () => { done = true; registerContainer(null) }
      }, [])

      React.useEffect(() => {
        const onUp = (ev) => {
          if (ev && ev.target && ev.target.closest && ev.target.closest('[data-snote-ui]')) return
          window.requestAnimationFrame(handleSelectionChange)
        }
        document.addEventListener('mouseup', onUp)
        return () => document.removeEventListener('mouseup', onUp)
      }, [])

      return React.createElement('div', { ref, 'data-snote-anchor': true, style: { display: 'none' } })
    }

    const SelButton = (props) => {
      const sel = props.sel
      return React.createElement('button', {
        className: 'snote-selbtn', 'data-snote-ui': true,
        style: {
          left: Math.max(12, Math.min(sel.x, window.innerWidth - 130)) + 'px',
          top: Math.max(64, sel.y - 46) + 'px',
        },
        onClick: () => { S.editing = { mode: 'new', quote: sel.quote }; S.sel = null; emit() },
      }, '📝 记便签')
    }

    const Editor = (props) => {
      const editing = props.editing
      const isView = editing.mode === 'view'
      const notePair = React.useState('')
      const quotePair = React.useState('')
      const scopePair = React.useState('session')
      const kindPair = React.useState('note')
      const nextPair = React.useState('')
      const doneWhenPair = React.useState('')
      const duePair = React.useState('')
      const dueActionPair = React.useState('auto')
      const presetPair = React.useState('')
      const note = notePair[0]; const setNote = notePair[1]
      const quote = quotePair[0]; const setQuote = quotePair[1]
      const scope = scopePair[0]; const setScope = scopePair[1]
      const kind = kindPair[0]; const setKind = kindPair[1]
      const next = nextPair[0]; const setNext = nextPair[1]
      const doneWhen = doneWhenPair[0]; const setDoneWhen = doneWhenPair[1]
      const dueLocal = duePair[0]; const setDueLocal = duePair[1]
      const dueAction = dueActionPair[0]; const setDueAction = dueActionPair[1]
      const preset = presetPair[0]; const setPreset = presetPair[1]
      const areaRef = React.useRef(null)

      React.useEffect(() => {
        const src = editing.noteObj
        setNote(editing.mode === 'edit' ? (editing.text || '') : '')
        setQuote(editing.mode === 'manual' ? '' : (editing.quote || ''))
        const defScope = editing.scope || (S.filter === 'workspace' ? 'workspace' : S.filter === 'session' ? 'session' : 'global')
        setScope(defScope)
        setKind(src && src.kind ? src.kind : 'note')
        setNext(src && src.next ? src.next : '')
        setDoneWhen(src && src.doneWhen ? src.doneWhen : '')
        setDueLocal(src && src.dueAt ? toLocalInput(src.dueAt) : '')
        setDueAction(src && src.dueAction === 'notify' ? 'notify' : 'auto')
        setPreset(src && src.preset ? src.preset : '')
        if (editing.mode !== 'view') {
          snTimeout(() => { if (areaRef.current && areaRef.current.focus) areaRef.current.focus() }, 30)
        }
      }, [editing])

      const close = () => { S.editing = null; emit() }

      const save = async () => {
        const t = note.trim()
        const k = kind
        let saved = null
        if (k === 'status' && S.workspacePath) {
          // 状态便签:新建走替换语义,编辑保 kind 更新正文。
          saved = editing.mode === 'edit' && editing.id
            ? await updateTask(editing.id, { note: t, kind: 'status' })
            : await statusSet(t)
          if (editing.mode === 'new') clearBrowserSelection()
          close()
          return saved
        }
        const extra = k === 'task' ? {
          kind: 'task',
          next: next.trim(),
          doneWhen: doneWhen.trim(),
          dueAt: fromLocalInput(dueLocal),
          dueAction,
          preset: preset.trim(),
        } : { kind: k }
        if (editing.mode === 'edit') {
          if (t || (editing.quote || '').trim()) saved = await updateTask(editing.id, Object.assign({ note: t }, extra))
        } else if (editing.mode === 'manual') {
          const q = quote.trim()
          if (t || q) saved = await addManualNote(scope, q, t, extra)
        } else {
          if (t) saved = await addTaskFromSelection(editing.quote, t, extra)
        }
        if (editing.mode === 'new') clearBrowserSelection()
        close()
        return saved
      }
      const saveAndSend = async () => {
        const saved = await save()
        if (saved) sendToComposer(saved)
      }
      // NEW mode: send the quote straight to the composer WITHOUT saving a note.
      const sendNewOnly = () => {
        sendToComposer({ id: '', quote: editing.quote, note: note.trim() })
        if (editing.mode === 'new') clearBrowserSelection()
        close()
      }

      const enterEdit = () => {
        S.editing = { mode: 'edit', id: editing.id, quote: editing.quote, text: editing.text, noteObj: editing.noteObj, from: 'view' }
        emit()
      }
      const cancelEdit = () => {
        if (editing.from === 'view') {
          S.editing = { mode: 'view', id: editing.id, quote: editing.quote, text: editing.text, noteObj: editing.noteObj }
        } else {
          S.editing = null
        }
        emit()
      }
      const viewSend = () => {
        sendToComposer({ id: editing.id, quote: editing.quote, note: editing.text })
      }
      const viewDelete = () => {
        if (window.confirm('删除这条便签?')) { deleteNote(editing.id); close() }
      }

      const title = isView ? (editing.noteObj && editing.noteObj.kind === 'task' ? '任务' : '便签')
        : editing.mode === 'edit' ? '编辑' : editing.mode === 'manual' ? '新建' : '记便签'
      const scopeRow = editing.mode === 'manual' && kind !== 'status'
        ? React.createElement('div', { className: 'snote-scope-row' },
            React.createElement('span', { className: 'snote-scope-label' }, '归属'),
            React.createElement('select', {
              className: 'snote-select', value: scope,
              onChange: (e) => setScope(e.target.value),
            },
              React.createElement('option', { value: 'session' }, '本会话' + (S.sessionId ? '' : '(未打开,将存为全局)')),
              React.createElement('option', { value: 'workspace' }, '当前目录' + (S.workspaceTitle ? '(' + S.workspaceTitle + ')' : '')),
              React.createElement('option', { value: 'global' }, '全局 dsh'),
            ),
          )
        : null
      const quoteBlock = editing.mode === 'manual'
        ? React.createElement('textarea', {
            className: 'snote-quote-input', value: quote,
            placeholder: '引用原文(可选,会话内匹配到时显示划线)',
            onChange: (e) => setQuote(e.target.value),
          })
        : ((editing.quote || '').trim()
            ? React.createElement('div', { className: 'snote-quote' }, '「' + (editing.quote.length > 300 ? editing.quote.slice(0, 300) + '…' : editing.quote) + '」')
            : null)

      // ---- 任务字段区(kind === 'task' 且非查看态) ----
      const taskFields = (kind === 'task' && !isView)
        ? React.createElement('div', { className: 'snote-task-fields' },
            React.createElement('input', { className: 'snote-task-input', value: next, placeholder: '下一步：恢复时直接照做的动作(可选)', onChange: (e) => setNext(e.target.value) }),
            React.createElement('input', { className: 'snote-task-input', value: doneWhen, placeholder: '完成条件：什么情况算做完(可选)', onChange: (e) => setDoneWhen(e.target.value) }),
            React.createElement('div', { className: 'snote-due-row' },
              React.createElement('span', { className: 'snote-scope-label' }, '定时'),
              React.createElement('input', { className: 'snote-due-input', type: 'datetime-local', value: dueLocal, onChange: (e) => setDueLocal(e.target.value) }),
              React.createElement('button', { className: 'snote-mini', type: 'button', onClick: () => setDueLocal(quickDue('morning')) }, '明早9点'),
              React.createElement('button', { className: 'snote-mini', type: 'button', onClick: () => setDueLocal(quickDue('hours')) }, '5小时后'),
              dueLocal ? React.createElement('button', { className: 'snote-mini', type: 'button', onClick: () => setDueLocal('') }, '清除') : null,
            ),
            dueLocal
              ? React.createElement('div', { className: 'snote-due-row' },
                  React.createElement('span', { className: 'snote-scope-label' }, '到点'),
                  React.createElement('select', { className: 'snote-select', value: dueAction, onChange: (e) => setDueAction(e.target.value) },
                    React.createElement('option', { value: 'auto' }, '自动开新会话'),
                    React.createElement('option', { value: 'notify' }, '仅提醒'),
                  ),
                  React.createElement('span', { className: 'snote-due-hint' }, '到点将' + (dueAction === 'auto' ? '自动新会话' : '提醒') + (preset.trim() ? '(preset：' + preset.trim() + ')' : '')),
                )
              : null,
            React.createElement('input', { className: 'snote-task-input', value: preset, placeholder: 'agent 预设(可选,留空默认继承来源会话)', onChange: (e) => setPreset(e.target.value) }),
          )
        : null

      // ---- 类型选择(新建/编辑态) ----
      const kindRow = !isView
        ? React.createElement('div', { className: 'snote-scope-row' },
            React.createElement('span', { className: 'snote-scope-label' }, '类型'),
            React.createElement('select', {
              className: 'snote-select', value: kind,
              onChange: (e) => setKind(e.target.value),
            },
              React.createElement('option', { value: 'note' }, '便签'),
              React.createElement('option', { value: 'task' }, '任务'),
              React.createElement('option', { value: 'status' }, '状态(当前目录)'),
            ),
          )
        : null

      if (isView) {
        const n = editing.noteObj || {}
        const badge = taskDueBadge(n)
        return React.createElement('div', { className: 'snote-mask', 'data-snote-ui': true, onClick: close },
          React.createElement('div', { className: 'snote-modal', onClick: (e) => { e.stopPropagation() } },
            React.createElement('div', { className: 'snote-modal-title' }, title),
            badge ? React.createElement('div', { className: 'snote-badge ' + badge.cls }, badge.text) : null,
            n.kind === 'task' && (n.next || n.doneWhen)
              ? React.createElement('div', { className: 'snote-view-note' },
                  n.next ? '下一步：' + n.next + '\n\n' : '',
                  n.doneWhen ? '完成条件：' + n.doneWhen : '',
                )
              : null,
            quoteBlock,
            React.createElement('div', { className: 'snote-view-note' }, (editing.text || '').trim() ? editing.text : '(空)'),
            React.createElement('div', { className: 'snote-modal-actions' },
              React.createElement('button', { className: 'snote-btn snote-btn-danger', onClick: viewDelete }, '删除'),
              n.kind === 'task' ? React.createElement('button', { className: 'snote-btn snote-btn-spawn', onClick: () => { close(); spawnTask(n.id) } }, '▶ 新会话继续') : null,
              React.createElement('button', { className: 'snote-btn snote-btn-send', onClick: viewSend, style: { marginLeft: 'auto' } }, '发送到对话框'),
              React.createElement('button', { className: 'snote-btn', onClick: enterEdit }, '编辑'),
              React.createElement('button', { className: 'snote-btn snote-btn-primary', onClick: close }, '关闭'),
            ),
          ),
        )
      }

      const showSend = editing.mode === 'edit' && note.trim().length > 0
      return React.createElement('div', { className: 'snote-mask', 'data-snote-ui': true, onClick: close },
        React.createElement('div', { className: 'snote-modal', onClick: (e) => { e.stopPropagation() } },
          React.createElement('div', { className: 'snote-modal-title' }, title),
          kindRow,
          scopeRow,
          quoteBlock,
          React.createElement('textarea', {
            ref: (el) => { areaRef.current = el },
            className: 'snote-input', value: note,
            placeholder: kind === 'status' ? '当前做到哪了？一行话(更新=替换,不是追加)…' : kind === 'task' ? '要做什么？(新会话将以此为任务)…' : '便签内容… (⌘/Ctrl+Enter 保存)',
            onChange: (e) => setNote(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save() },
          }),
          taskFields,
          React.createElement('div', { className: 'snote-modal-actions' },
            React.createElement('button', { className: 'snote-btn', onClick: cancelEdit }, '取消'),
            editing.mode === 'new'
              ? React.createElement('button', { className: 'snote-btn snote-btn-send', title: '只发送到输入框,不保存便签、不划线', onClick: sendNewOnly }, '发送到对话框')
              : null,
            showSend
              ? React.createElement('button', { className: 'snote-btn snote-btn-send', onClick: saveAndSend }, '发送到对话框')
              : null,
            React.createElement('button', { className: 'snote-btn snote-btn-primary', onClick: save }, '保存'),
          ),
        ),
      )
    }

    const trunc = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)
    const shortId = (id) => (id ? id.slice(0, 8) : '?')
    const fmtTime = (iso) => {
      const d = new Date(iso)
      if (isNaN(d.getTime())) return ''
      const p = (v) => (v < 10 ? '0' : '') + v
      return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    const filteredNotes = () => {
      const all = S.notes.slice().sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? 1 : -1))
      if (S.filter === 'session' && S.sessionId) return all.filter((n) => n.sessionId === S.sessionId)
      if (S.filter === 'workspace' && S.workspacePath) return all.filter((n) => n.workspacePath === S.workspacePath)
      return all
    }

    const NoteCard = (props) => {
      const n = props.note
      const kind = n.kind || 'note'
      const isCurrent = S.sessionId && n.sessionId === S.sessionId
      const scopeTag = n.sessionId ? (isCurrent ? '本会话' : '会话 ' + shortId(n.sessionId)) : (n.workspacePath ? (n.workspaceTitle || '目录') : '全局')
      const badge = taskDueBadge(n)
      const kindTag = kind === 'status' ? '📌状态' : kind === 'task' ? '☑任务' : null
      const notifyPending = kind === 'task' && n.firedAt && !n.notifyDismissed && !(n.spawnLog || []).length && !n.done
      const originLostPending = kind === 'task' && n.originLost && n.dueAt && !n.firedAt && n.downgraded
      return React.createElement('div', { className: 'snote-card' + (kind === 'status' ? ' snote-card-status' : '') + (n.done ? ' snote-card-done' : '') },
        React.createElement('div', { className: 'snote-card-meta' },
          kindTag ? React.createElement('span', { className: 'snote-kind-tag' }, kindTag) : null,
          badge ? React.createElement('span', { className: 'snote-badge ' + badge.cls }, badge.text) : null,
          n.originLost ? React.createElement('span', { className: 'snote-badge snote-badge-warn', title: '来源会话已删除,上下文可能不完整' }, '来源已删') : null,
          n.originArchived ? React.createElement('span', { className: 'snote-badge snote-badge-dim', title: '来源会话已归档' }, '已归档') : null,
          React.createElement('span', { style: { marginLeft: 'auto' } }),
          React.createElement('span', { className: 'snote-card-src', title: n.workspacePath || '' }, scopeTag),
          React.createElement('span', { className: 'snote-card-time' }, fmtTime(n.createdAt)),
        ),
        n.quote ? React.createElement('div', { className: 'snote-card-quote' }, '「' + trunc(n.quote || '', 90) + '」') : null,
        React.createElement('div', { className: 'snote-card-note' }, n.note || '(空)'),
        kind === 'task' && (n.next || n.doneWhen)
          ? React.createElement('div', { className: 'snote-task-summary' },
              n.next ? React.createElement('div', null, '→ ' + trunc(n.next, 120)) : null,
              n.doneWhen ? React.createElement('div', null, '✓? ' + trunc(n.doneWhen, 120)) : null,
            )
          : null,
        notifyPending
          ? React.createElement('div', { className: 'snote-alert-row snote-alert-warn' },
              React.createElement('button', { className: 'snote-mini snote-mini-send', onClick: () => spawnTask(n.id) }, '▶ 到点了,开跑'),
              React.createElement('button', { className: 'snote-mini', onClick: () => ackNote(n.id, 'dismiss') }, '忽略'),
            )
          : null,
        originLostPending
          ? React.createElement('div', { className: 'snote-alert-row snote-alert-warn' },
              React.createElement('span', { className: 'snote-due-hint' }, '来源会话已删,自动开跑已降级为提醒'),
              React.createElement('button', { className: 'snote-mini snote-mini-send', onClick: () => ackNote(n.id, 'restore-auto') }, '照常自动跑'),
              React.createElement('button', { className: 'snote-mini', onClick: () => ackNote(n.id, 'cancel-due') }, '取消定时'),
            )
          : null,
        kind === 'task' && n.fireState === 'failed'
          ? React.createElement('div', { className: 'snote-alert-row snote-alert-warn' },
              React.createElement('span', { className: 'snote-due-hint' }, '上次自动启动失败'),
              React.createElement('button', { className: 'snote-mini snote-mini-send', onClick: () => spawnTask(n.id) }, '重试(手动开跑)'),
            )
          : null,
        React.createElement('div', { className: 'snote-card-actions' },
          kind === 'task' ? React.createElement('label', { className: 'snote-done-check', title: '完成勾选(完成后不再触发定时)' },
            React.createElement('input', { type: 'checkbox', checked: !!n.done, onChange: (e) => updateTask(n.id, { done: e.target.checked }) }),
            '完成',
          ) : null,
          kind === 'task' ? React.createElement('button', {
            className: 'snote-mini snote-mini-send', title: '用这条任务开一个新会话(开场消息=任务+来源上下文)',
            onClick: () => spawnTask(n.id),
          }, '▶ 新会话') : null,
          isCurrent && n.quote ? React.createElement('button', { className: 'snote-mini', onClick: () => revealNote(n.id) }, '定位') : null,
          React.createElement('button', {
            className: 'snote-mini snote-mini-send', title: '追加到当前会话的输入框',
            onClick: () => sendToComposer(n),
          }, '发送到对话框'),
          React.createElement('button', {
            className: 'snote-mini',
            onClick: () => { S.editing = { mode: 'edit', id: n.id, quote: n.quote, text: n.note, noteObj: n }; emit() },
          }, '编辑'),
          React.createElement('button', {
            className: 'snote-mini snote-mini-danger',
            onClick: () => { if (window.confirm('删除这条便签?')) deleteNote(n.id) },
          }, '删除'),
        ),
      )
    }

    const Panel = (props) => {
      useStore()
      const closePanel = props && typeof props.onClose === 'function'
        ? props.onClose
        : () => { S.panelOpen = false; emit() }
      const inTab = !!(props && props.inTab)
      const wsCount = S.workspacePath ? S.notes.filter((n) => n.workspacePath === S.workspacePath).length : 0
      const sCount = S.sessionId ? S.notes.filter((n) => n.sessionId === S.sessionId).length : 0
      const statusNote = S.workspacePath ? S.notes.find((n) => n.kind === 'status' && n.workspacePath === S.workspacePath) : null
      // 状态便签只住在 Current 行,不进列表(替换语义,列表重复无意义)。
      const list = filteredNotes().filter((n) => n.kind !== 'status')
      const tab = (key, label) => React.createElement('button', {
        key,
        className: 'snote-tab' + (S.filter === key ? ' snote-tab-active' : ''),
        onClick: () => { S.filter = key; emit() },
      }, label)
      const openManual = () => {
        S.editing = { mode: 'manual', scope: S.filter === 'workspace' ? 'workspace' : S.filter === 'session' ? 'session' : 'global' }
        emit()
      }
      const editStatus = () => {
        if (statusNote) { S.editing = { mode: 'edit', id: statusNote.id, quote: '', text: statusNote.note, noteObj: statusNote }; emit() }
        else if (S.workspacePath) { S.editing = { mode: 'manual', scope: 'workspace', noteObj: { kind: 'status' } }; emit() }
        else showToast('当前没有打开的目录,无法设置状态')
      }
      return React.createElement('div', { className: inTab ? 'snote-tabpane' : 'snote-panel', 'data-snote-ui': true },
        React.createElement('div', { className: 'snote-panel-head' },
          React.createElement('span', { className: 'snote-panel-title' }, '会话便签'),
          React.createElement('span', { className: 'snote-panel-sub' }, String(S.notes.length) + ' 条'),
          React.createElement('button', {
            className: 'snote-new-btn', title: '新建便签/任务/状态', onClick: openManual,
          }, '＋ 新建'),
          React.createElement('button', {
            className: 'snote-panel-close', title: '关闭',
            onClick: closePanel,
          }, '✕'),
        ),
        React.createElement('div', { className: 'snote-current' + (statusNote ? '' : ' snote-current-empty'), onClick: editStatus, title: statusNote ? '点击编辑当前状态(更新=替换)' : '点击设置当前目录的工作状态' },
          React.createElement('span', { className: 'snote-current-label' }, '当前'),
          React.createElement('span', { className: 'snote-current-text' }, statusNote ? (statusNote.note || '(空)') : '＋ 一句话说清做到哪了'),
        ),
        React.createElement('div', { className: 'snote-tabs' },
          tab('all', '全部 ' + S.notes.length),
          tab('workspace', S.workspaceTitle ? (S.workspaceTitle + ' ' + wsCount) : '当前目录'),
          tab('session', '本会话 ' + sCount),
        ),
        S.error ? React.createElement('div', { className: 'snote-empty' }, '加载失败: ' + S.error) : null,
        !S.error && list.length === 0
          ? React.createElement('div', { className: 'snote-empty' },
              S.notes.length === 0 ? '还没有便签。选中消息文字点「📝 记便签」,或点右上「＋ 新建」。' : '此过滤条件下没有便签。')
          : null,
        React.createElement('div', { className: 'snote-list' },
          list.map((n) => React.createElement(NoteCard, { key: n.id, note: n })),
        ),
      )
    }

    // ---- right-Sidebar tab (dsh >= 0.1.5, mirrors dsh-files) ----
    let rightbar = null
    const NotesTabBody = (tabProps) => React.createElement(Panel, {
      inTab: true,
      onClose: () => { try { if (rightbar !== null && rightbar.isExpanded()) rightbar.toggleExpanded() } catch (e) {} },
    })

    const OverlayUI = () => {
      const st = useStore()
      React.useEffect(() => { if (!st.loaded && st.error === null) loadNotes() }, [])
      React.useEffect(() => {
        const onKey = (ev) => {
          if (ev.key === 'Escape' && S.editing) { S.editing = null; S.sel = null; emit() }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [])
      const children = []
      if (st.sel && !st.editing) children.push(React.createElement(SelButton, { key: 'sel', sel: st.sel }))
      if (st.editing) children.push(React.createElement(Editor, { key: (st.editing.mode === 'view' || st.editing.mode === 'edit' ? st.editing.id : st.editing.mode) + (st.editing.mode === 'edit' && st.editing.from === 'view' ? '-edit' : ''), editing: st.editing }))
      if (st.panelOpen) children.push(React.createElement(Panel, { key: 'panel' }))
      if (st.toast) children.push(React.createElement('div', { key: 'toast', className: 'snote-toast' }, st.toast))
      return React.createElement(React.Fragment, null, children)
    }

    const HeaderBtn = (props) => {
      useStore()
      const sid = props.sessionId
      const count = sid ? S.notes.filter((n) => n.sessionId === sid).length : 0
      const duePending = S.notes.filter((n) => n.kind === 'task' && !n.done && n.firedAt && !n.notifyDismissed && !(n.spawnLog || []).length).length
      return React.createElement('button', {
        className: 'snote-header-btn', 'data-snote-ui': true, title: '打开会话便签面板',
        onClick: () => {
          if (rightbar !== null && sid) {
            try { rightbar.openTabIn(sid, 'session-notes') } catch (e) { S.panelOpen = !S.panelOpen; emit() }
            return
          }
          S.panelOpen = !S.panelOpen; emit()
        },
      }, '便签' + (count > 0 ? ' · ' + count : '') + (duePending > 0 ? ' ⏰' + duePending : ''))
    }

    const onDocClick = (ev) => {
      const t = ev.target
      if (!t) return
      if (supportsHighlight) {
        const x = ev.clientX
        const y = ev.clientY
        for (let i = 0; i < noteRanges.length; i++) {
          const nr = noteRanges[i]
          if (!rangeAlive(nr)) continue
          let hit = false
          try {
            const rects = nr.range.getClientRects()
            for (let j = 0; j < rects.length; j++) {
              const r = rects[j]
              if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { hit = true; break }
            }
          } catch (e) {}
          if (hit) { openView(nr.id); return }
        }
        return
      }
      if (!t.closest) return
      const mark = t.closest('mark.snote-mark')
      if (!mark) return
      openView(mark.getAttribute('data-snote-id'))
    }
    if (window.__snoteDocClick) document.removeEventListener('click', window.__snoteDocClick)
    window.__snoteDocClick = onDocClick
    document.addEventListener('click', onDocClick)

    // ---------- styles ----------
    snInsertStyles([
      '::highlight(snote-hl){background-color:rgba(250,204,21,.34);text-decoration:underline;text-decoration-color:rgba(234,160,11,.85);text-decoration-thickness:2px;text-underline-offset:3px}',
      '.snote-mark{background:rgba(250,204,21,.32);color:inherit;border-radius:2px;padding:0 1px;border-bottom:2px solid rgba(234,160,11,.75);cursor:pointer;transition:background .15s}',
      '.snote-mark:hover{background:rgba(250,204,21,.55)}',
      '.snote-flash{animation:snote-flash 1.4s ease}',
      '@keyframes snote-flash{0%,100%{box-shadow:none}25%,60%{box-shadow:0 0 0 4px rgba(250,204,21,.6)}}',
      '.snote-selbtn{position:fixed;z-index:60;transform:translateX(-50%);display:flex;align-items:center;gap:4px;height:30px;padding:0 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font-size:12px;cursor:pointer;box-shadow:var(--dsw-elevation-panel,0 4px 14px rgba(0,0,0,.14))}',
      '.snote-selbtn:hover{background:var(--dsw-alias-bg-layer-1,#fff);filter:brightness(.94)}',
      '.snote-mask{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;padding:24px}',
      '.snote-modal{width:min(560px,92vw);max-height:82vh;overflow:auto;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-base,#fff);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.22));padding:16px;display:flex;flex-direction:column;gap:10px}',
      '.snote-modal-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}',
      '.snote-view-note{font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary,#111);white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));border-radius:8px;padding:12px;max-height:50vh;overflow:auto}',
      '.snote-scope-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.snote-scope-label{font-size:12px;color:var(--dsw-alias-label-secondary,#666)}',
      '.snote-select{font:inherit;font-size:12px;padding:4px 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fafafa);color:var(--dsw-alias-label-primary,#111);max-width:320px}',
      '.snote-quote{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));border-radius:8px;padding:8px 10px;max-height:110px;overflow:auto;border-left:3px solid rgba(234,160,11,.6)}',
      '.snote-quote-input{font:inherit;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#555);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-left:3px solid rgba(234,160,11,.6);border-radius:8px;padding:8px 10px;min-height:54px;resize:vertical;outline:none;width:100%;box-sizing:border-box}',
      '.snote-quote-input:focus{border-color:rgba(234,160,11,.8)}',
      '.snote-input{font:inherit;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-bg-layer-1,#fafafa);border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;padding:10px;min-height:90px;resize:vertical;outline:none;box-sizing:border-box;width:100%}',
      '.snote-input:focus{border-color:var(--dsw-alias-state-business-primary,#e0a010)}',
      '.snote-modal-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap}',
      '.snote-btn{font:inherit;font-size:12px;padding:6px 14px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fafafa);color:var(--dsw-alias-label-primary,#111);cursor:pointer}',
      '.snote-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.snote-btn-send{color:#b45309;border-color:rgba(234,160,11,.55)}',
      '.snote-btn-send:hover{background:rgba(250,204,21,.18)}',
      '.snote-btn-spawn{color:#0e7490;border-color:rgba(14,116,144,.5)}',
      '.snote-btn-spawn:hover{background:rgba(14,116,144,.08)}',
      '.snote-btn-danger{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.snote-btn-danger:hover{background:rgba(220,38,38,.08)}',
      '.snote-btn-primary{background:var(--dsw-alias-state-business-primary,#e0a010);border-color:transparent;color:#fff}',
      '.snote-btn-primary:hover{filter:brightness(1.06)}',
      '.snote-task-fields{display:flex;flex-direction:column;gap:8px;border:.5px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:10px;padding:10px}',
      '.snote-task-input{font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-bg-layer-1,#fafafa);border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;padding:7px 10px;outline:none;box-sizing:border-box;width:100%}',
      '.snote-task-input:focus{border-color:var(--dsw-alias-state-business-primary,#e0a010)}',
      '.snote-due-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.snote-due-input{font:inherit;font-size:12px;padding:4px 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fafafa);color:var(--dsw-alias-label-primary,#111)}',
      '.snote-due-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}',
      '.snote-tabpane{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#fff)}',
      '.snote-panel{position:fixed;top:0;right:0;bottom:0;width:328px;z-index:55;display:flex;flex-direction:column;border-left:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14));border-radius:0;background:var(--dsw-alias-bg-base,#fff);overflow:hidden;animation:snote-slide-in .18s ease}',
      '@keyframes snote-slide-in{from{transform:translateX(26px);opacity:.35}to{transform:none;opacity:1}}',
      '.snote-panel-head{display:flex;align-items:center;gap:8px;padding:12px 12px 8px}',
      '.snote-panel-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}',
      '.snote-panel-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}',
      '.snote-new-btn{font:inherit;font-size:11px;padding:3px 10px;border-radius:8px;border:.5px solid rgba(234,160,11,.55);background:transparent;color:#b45309;cursor:pointer;white-space:nowrap}',
      '.snote-new-btn:hover{background:rgba(250,204,21,.18)}',
      '.snote-panel-close{margin-left:auto;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:13px;cursor:pointer;padding:4px 6px;border-radius:6px}',
      '.snote-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.snote-current{display:flex;align-items:center;gap:8px;margin:0 10px 8px;padding:8px 10px;border-radius:10px;background:linear-gradient(90deg,rgba(250,204,21,.14),rgba(250,204,21,.05));border:.5px solid rgba(234,160,11,.35);cursor:pointer}',
      '.snote-current:hover{filter:brightness(.97)}',
      '.snote-current-empty{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03));border-style:dashed;border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.14))}',
      '.snote-current-label{flex:none;font-size:10.5px;font-weight:600;color:#b45309;border:1px solid rgba(234,160,11,.5);border-radius:999px;padding:1px 7px}',
      '.snote-current-text{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,#111);white-space:pre-wrap;word-break:break-word;max-height:72px;overflow:hidden}',
      '.snote-tabs{display:flex;gap:4px;padding:0 10px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
      '.snote-tab{font:inherit;font-size:11px;padding:4px 9px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis}',
      '.snote-tab-active{background:var(--dsw-alias-state-business-primary,#e0a010);border-color:transparent;color:#fff;font-weight:600}',
      '.snote-list{flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px}',
      '.snote-card{border:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1,#fafafa)}',
      '.snote-card:hover{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.16))}',
      '.snote-card-status{background:linear-gradient(90deg,rgba(250,204,21,.1),transparent)}',
      '.snote-card-done{opacity:.62}',
      '.snote-card-quote{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary,#666);border-left:3px solid rgba(234,160,11,.55);padding-left:8px;max-height:72px;overflow:hidden}',
      '.snote-card-note{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary,#111);white-space:pre-wrap;word-break:break-word}',
      '.snote-card-meta{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#999);flex-wrap:wrap}',
      '.snote-card-src{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.snote-card-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
      '.snote-kind-tag{font-weight:600;color:#b45309}',
      '.snote-badge{flex:none;font-size:10px;padding:1px 7px;border-radius:999px;border:.5px solid transparent;white-space:nowrap}',
      '.snote-badge-info{color:#1d4ed8;background:rgba(59,130,246,.1);border-color:rgba(59,130,246,.35)}',
      '.snote-badge-warn{color:#b45309;background:rgba(250,204,21,.15);border-color:rgba(234,160,11,.45)}',
      '.snote-badge-ok{color:#047857;background:rgba(16,185,129,.1);border-color:rgba(16,185,129,.35)}',
      '.snote-badge-fail{color:#b91c1c;background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.4)}',
      '.snote-badge-dim{color:var(--dsw-alias-label-tertiary,#999);background:rgba(0,0,0,.04);border-color:var(--dsw-alias-border-l1,rgba(0,0,0,.1))}',
      '.snote-task-summary{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#666);border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));padding-left:8px}',
      '.snote-alert-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}',
      '.snote-alert-warn{background:rgba(250,204,21,.12)}',
      '.snote-done-check{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary,#555);cursor:pointer}',
      '.snote-mini{font:inherit;font-size:11px;padding:3px 10px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-secondary,#555);cursor:pointer;white-space:nowrap}',
      '.snote-mini:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}',
      '.snote-mini-send{color:#b45309;border-color:rgba(234,160,11,.5)}',
      '.snote-mini-send:hover{background:rgba(250,204,21,.18);color:#b45309}',
      '.snote-mini-danger:hover{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.snote-empty{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#999);padding:22px 14px;text-align:center}',
      '.snote-toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);z-index:80;max-width:80vw;padding:8px 18px;border-radius:10px;background:rgba(20,20,20,.9);color:#fff;font-size:12.5px;box-shadow:0 6px 20px rgba(0,0,0,.25);white-space:pre-wrap;word-break:break-all}',
      '.snote-header-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-secondary,#555);cursor:pointer;white-space:nowrap}',
      '.snote-header-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}',
    ].join('\n'))

    // ---------- slot registrations ----------
    ctx.effect(() => slots.inject('conversation.composer.dock', () =>
      slots.register(
        { name: 'conversation.composer.dock', id: 'session-notes-anchor', order: 90, label: '便签锚点' },
        (props) => React.createElement(Anchor, props),
      ),
    ))

    ctx.effect(() => slots.inject('conversation.session.header.utilities', () =>
      slots.register(
        { name: 'conversation.session.header.utilities', id: 'session-notes-toggle', order: 60, label: '便签' },
        (props) => React.createElement(HeaderBtn, props),
      ),
    ))

    ctx.effect(() => slots.inject('shell.overlay', () =>
      slots.register(
        { name: 'shell.overlay', id: 'session-notes-ui', order: 50, label: '会话便签' },
        () => React.createElement(OverlayUI),
      ),
    ))

    // dsh >= 0.1.5: first-class right-Sidebar tab (mirrors dsh-files). The docked
    // overlay above stays dormant as the fallback when the service is absent.
    ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => {
      rightbar = scope.sidebarRight
      const disposeType = scope.sidebarRightTabs.register({
        id: 'session-notes',
        kind: 'session-notes',
        priority: 'extension',
        title: () => '便签',
      })
      const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: 'session-notes' },
        NotesTabBody,
      ))
      scope.effect(() => () => {
        rightbar = null
        try { disposeBody() } catch (e) {}
        try { disposeType() } catch (e) {}
      }, 'session-notes: rightbar teardown')
    })

    // teardown: highlights, observer, timers, styles, global delegate
    return () => {
      try { if (supportsHighlight) clearApiHighlights(); else clearMarkHighlights() } catch (e) {}
      if (mo) { mo.disconnect(); mo = null }
      container = null
      clearAllTimers()
      if (styleDisposer) { styleDisposer(); styleDisposer = null }
      if (window.__snoteDocClick === onDocClick) {
        document.removeEventListener('click', onDocClick)
        window.__snoteDocClick = null
      }
    }
    }

    module.exports = { inject: ['slots', 'sessions'], apply }
    return module.exports
  },
})
