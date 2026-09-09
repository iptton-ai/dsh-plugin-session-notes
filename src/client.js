return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    // ---------- shared store (closure-scoped, shared by all slot entries) ----------
    const S = {
      notes: [], loaded: false, error: null,
      sessionId: null, workspacePath: null, workspaceTitle: null,
      inputActions: null, draftText: '',
      panelOpen: false, filter: 'all',
      sel: null, editing: null, toast: null,
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
      ctx.timeout(() => { if (S.toast === text) { S.toast = null; emit() } }, ms || 2400)
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
      try { host.call('notes/diag', Object.assign({ key }, data)) } catch (e) {}
    }

    // ---------- host RPC ----------
    const loadNotes = async () => {
      try {
        const res = await host.call('notes/list')
        if (res && res.ok) { S.notes = Array.isArray(res.notes) ? res.notes : []; S.loaded = true; S.error = null }
        else S.error = (res && res.error) || 'load failed'
      } catch (e) { S.error = String(e) }
      emit()
      applyAll()
    }
    const addNoteRpc = async (payload) => {
      const res = await host.call('notes/add', payload)
      if (res && res.ok) { S.notes.push(res.note); emit(); applyAll(); return res.note }
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
    const addManualNote = async (scope, quote, text) => {
      try {
        const payload = { quote: quote, note: text, workspaceTitle: S.workspaceTitle || '' }
        if (scope === 'session') { payload.sessionId = S.sessionId || ''; payload.workspacePath = S.workspacePath || '' }
        else if (scope === 'workspace') { payload.sessionId = ''; payload.workspacePath = S.workspacePath || '' }
        else { payload.sessionId = ''; payload.workspacePath = '' }
        if (scope === 'session' && !S.sessionId) { showToast('当前没有打开的会话,已存为全局便签') }
        const note = await addNoteRpc(payload)
        showToast('已新建便签 ✓')
        return note
      } catch (e) { showErr('保存失败', e); return null }
    }
    const updateNote = async (id, text) => {
      try {
        const res = await host.call('notes/update', { id, note: text })
        if (res && res.ok) {
          const n = S.notes.find((x) => x.id === id)
          if (n) { n.note = res.note.note; n.updatedAt = res.note.updatedAt }
          emit(); applyAll(); showToast('已更新 ✓')
          return n || res.note
        }
        showErr('更新失败', (res && res.error) || new Error('unknown'))
        return null
      } catch (e) { showErr('更新失败', e); return null }
    }
    const deleteNote = async (id) => {
      try {
        const res = await host.call('notes/delete', { id })
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
    const reapply = ctx.debounce(() => { applyAll() }, 400)

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

    ctx.interval(function () {
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
      if (n) { S.editing = { mode: 'view', id: n.id, quote: n.quote, text: n.note }; emit() }
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
      const note = notePair[0]; const setNote = notePair[1]
      const quote = quotePair[0]; const setQuote = quotePair[1]
      const scope = scopePair[0]; const setScope = scopePair[1]
      const areaRef = React.useRef(null)
      React.useEffect(() => {
        setNote(editing.mode === 'edit' ? (editing.text || '') : '')
        setQuote(editing.mode === 'manual' ? '' : (editing.quote || ''))
        const defScope = editing.scope || (S.filter === 'workspace' ? 'workspace' : S.filter === 'session' ? 'session' : 'global')
        setScope(defScope)
        if (editing.mode !== 'view') {
          ctx.timeout(() => { if (areaRef.current && areaRef.current.focus) areaRef.current.focus() }, 30)
        }
      }, [editing])
      const close = () => { S.editing = null; emit() }

      const save = async () => {
        const t = note.trim()
        let saved = null
        if (editing.mode === 'edit') {
          if (t || (editing.quote || '').trim()) saved = await updateNote(editing.id, t)
        } else if (editing.mode === 'manual') {
          const q = quote.trim()
          if (t || q) saved = await addManualNote(scope, q, t)
        } else {
          if (t) saved = await addNote(editing.quote, t)
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
        S.editing = { mode: 'edit', id: editing.id, quote: editing.quote, text: editing.text, from: 'view' }
        emit()
      }
      const cancelEdit = () => {
        if (editing.from === 'view') {
          S.editing = { mode: 'view', id: editing.id, quote: editing.quote, text: editing.text }
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

      const title = isView ? '便签' : editing.mode === 'edit' ? '编辑便签' : editing.mode === 'manual' ? '新建便签' : '记便签'
      const scopeRow = editing.mode === 'manual'
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

      if (isView) {
        return React.createElement('div', { className: 'snote-mask', 'data-snote-ui': true, onClick: close },
          React.createElement('div', { className: 'snote-modal', onClick: (e) => { e.stopPropagation() } },
            React.createElement('div', { className: 'snote-modal-title' }, title),
            quoteBlock,
            React.createElement('div', { className: 'snote-view-note' }, (editing.text || '').trim() ? editing.text : '(空)'),
            React.createElement('div', { className: 'snote-modal-actions' },
              React.createElement('button', { className: 'snote-btn snote-btn-danger', onClick: viewDelete }, '删除'),
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
          scopeRow,
          quoteBlock,
          React.createElement('textarea', {
            ref: (el) => { areaRef.current = el },
            className: 'snote-input', value: note, placeholder: '便签内容… (⌘/Ctrl+Enter 保存)',
            onChange: (e) => setNote(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save() },
          }),
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
      const isCurrent = S.sessionId && n.sessionId === S.sessionId
      const scopeTag = n.sessionId ? (isCurrent ? '本会话' : '会话 ' + shortId(n.sessionId)) : (n.workspacePath ? (n.workspaceTitle || '目录') : '全局')
      return React.createElement('div', { className: 'snote-card' },
        n.quote ? React.createElement('div', { className: 'snote-card-quote' }, '「' + trunc(n.quote || '', 90) + '」') : null,
        React.createElement('div', { className: 'snote-card-note' }, n.note || '(空)'),
        React.createElement('div', { className: 'snote-card-meta' },
          React.createElement('span', { className: 'snote-card-src', title: n.workspacePath || '' }, scopeTag),
          React.createElement('span', { className: 'snote-card-time' }, fmtTime(n.createdAt)),
        ),
        React.createElement('div', { className: 'snote-card-actions' },
          isCurrent && n.quote ? React.createElement('button', { className: 'snote-mini', onClick: () => revealNote(n.id) }, '定位') : null,
          React.createElement('button', {
            className: 'snote-mini snote-mini-send', title: '追加到当前会话的输入框',
            onClick: () => sendToComposer(n),
          }, '发送到对话框'),
          React.createElement('button', {
            className: 'snote-mini',
            onClick: () => { S.editing = { mode: 'edit', id: n.id, quote: n.quote, text: n.note }; emit() },
          }, '编辑'),
          React.createElement('button', {
            className: 'snote-mini snote-mini-danger',
            onClick: () => { if (window.confirm('删除这条便签?')) deleteNote(n.id) },
          }, '删除'),
        ),
      )
    }

    const Panel = () => {
      useStore()
      const wsCount = S.workspacePath ? S.notes.filter((n) => n.workspacePath === S.workspacePath).length : 0
      const sCount = S.sessionId ? S.notes.filter((n) => n.sessionId === S.sessionId).length : 0
      const list = filteredNotes()
      const tab = (key, label) => React.createElement('button', {
        key,
        className: 'snote-tab' + (S.filter === key ? ' snote-tab-active' : ''),
        onClick: () => { S.filter = key; emit() },
      }, label)
      const openManual = () => {
        S.editing = { mode: 'manual', scope: S.filter === 'workspace' ? 'workspace' : S.filter === 'session' ? 'session' : 'global' }
        emit()
      }
      return React.createElement('div', { className: 'snote-panel', 'data-snote-ui': true },
        React.createElement('div', { className: 'snote-panel-head' },
          React.createElement('span', { className: 'snote-panel-title' }, '会话便签'),
          React.createElement('span', { className: 'snote-panel-sub' }, String(S.notes.length) + ' 条'),
          React.createElement('button', {
            className: 'snote-new-btn', title: '新建便签(会话/目录/全局)', onClick: openManual,
          }, '＋ 新建'),
          React.createElement('button', {
            className: 'snote-panel-close', title: '关闭',
            onClick: () => { S.panelOpen = false; emit() },
          }, '✕'),
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
      return React.createElement('button', {
        className: 'snote-header-btn', 'data-snote-ui': true, title: '打开会话便签面板',
        onClick: () => { S.panelOpen = !S.panelOpen; emit() },
      }, '便签' + (count > 0 ? ' · ' + count : ''))
    }

    document.addEventListener('click', (ev) => {
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
    })

    // ---------- styles ----------
    styles.insert([
      '::highlight(snote-hl){background-color:rgba(250,204,21,.34);text-decoration:underline;text-decoration-color:rgba(234,160,11,.85);text-decoration-thickness:2px;text-underline-offset:3px}',
      '.snote-mark{background:rgba(250,204,21,.32);color:inherit;border-radius:2px;padding:0 1px;border-bottom:2px solid rgba(234,160,11,.75);cursor:pointer;transition:background .15s}',
      '.snote-mark:hover{background:rgba(250,204,21,.55)}',
      '.snote-flash{animation:snote-flash 1.4s ease}',
      '@keyframes snote-flash{0%,100%{box-shadow:none}25%,60%{box-shadow:0 0 0 4px rgba(250,204,21,.6)}}',
      '.snote-selbtn{position:fixed;z-index:60;transform:translateX(-50%);display:flex;align-items:center;gap:4px;height:30px;padding:0 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font-size:12px;cursor:pointer;box-shadow:var(--dsw-elevation-panel,0 4px 14px rgba(0,0,0,.14))}',
      '.snote-selbtn:hover{background:var(--dsw-alias-bg-layer-1,#fff);filter:brightness(.94)}',
      '.snote-mask{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;padding:24px}',
      '.snote-modal{width:min(520px,92vw);max-height:80vh;overflow:auto;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-base,#fff);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.22));padding:16px;display:flex;flex-direction:column;gap:10px}',
      '.snote-modal-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}',
      '.snote-view-note{font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary,#111);white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));border-radius:8px;padding:12px;max-height:50vh;overflow:auto}',
      '.snote-scope-row{display:flex;align-items:center;gap:8px}',
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
      '.snote-btn-danger{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.snote-btn-danger:hover{background:rgba(220,38,38,.08)}',
      '.snote-btn-primary{background:var(--dsw-alias-state-business-primary,#e0a010);border-color:transparent;color:#fff}',
      '.snote-btn-primary:hover{filter:brightness(1.06)}',
      '.snote-panel{position:fixed;top:0;right:0;bottom:0;width:328px;z-index:55;display:flex;flex-direction:column;border-left:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14));border-radius:0;background:var(--dsw-alias-bg-base,#fff);overflow:hidden;animation:snote-slide-in .18s ease}',
      '@keyframes snote-slide-in{from{transform:translateX(26px);opacity:.35}to{transform:none;opacity:1}}',
      '.snote-panel-head{display:flex;align-items:center;gap:8px;padding:12px 12px 8px}',
      '.snote-panel-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}',
      '.snote-panel-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}',
      '.snote-new-btn{font:inherit;font-size:11px;padding:3px 10px;border-radius:8px;border:.5px solid rgba(234,160,11,.55);background:transparent;color:#b45309;cursor:pointer;white-space:nowrap}',
      '.snote-new-btn:hover{background:rgba(250,204,21,.18)}',
      '.snote-panel-close{margin-left:auto;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:13px;cursor:pointer;padding:4px 6px;border-radius:6px}',
      '.snote-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.snote-tabs{display:flex;gap:4px;padding:0 10px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
      '.snote-tab{font:inherit;font-size:11px;padding:4px 9px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis}',
      '.snote-tab-active{background:var(--dsw-alias-state-business-primary,#e0a010);border-color:transparent;color:#fff;font-weight:600}',
      '.snote-list{flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px}',
      '.snote-card{border:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1,#fafafa)}',
      '.snote-card:hover{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.16))}',
      '.snote-card-quote{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary,#666);border-left:3px solid rgba(234,160,11,.55);padding-left:8px;max-height:72px;overflow:hidden}',
      '.snote-card-note{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary,#111);white-space:pre-wrap;word-break:break-word}',
      '.snote-card-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#999)}',
      '.snote-card-src{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.snote-card-actions{display:flex;gap:6px;flex-wrap:wrap}',
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
  },
}
