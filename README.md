# Session Notes — DSH 会话划线便签插件

> Unofficial project, independently developed and maintained by community members.
> 非官方项目,由社区成员独立开发和维护。

Highlight any sentence in your DeepSeek Harness (DSH) conversation, attach a sticky note to it, and keep all notes in a right-side panel — filterable by current workspace (directory) or current session. Notes persist across restarts and can be sent straight back into the composer.

在 DeepSeek Harness (DSH) 的会话消息中**选中任意句子划线**并记一张小便签;右侧面板聚合展示全部便签,支持按**当前目录 / 本会话**过滤;便签跨重启持久化,还可一键**发送到对话框**继续追问。

![screenshot: highlight + notes panel](docs/screenshot-panel.png)

## Features / 功能

- ✍️ **Highlight & annotate** — select any text in a message (across bold/code/paragraph boundaries), click the floating **📝 记便签** button, write your note. The selection gets a persistent yellow highlight (CSS Custom Highlight API — zero DOM mutation, React-safe).
- 🗂 **Three scopes** — every note belongs to *this session*, *this workspace (directory)*, or *global (whole DSH)*. Create, edit and delete in the panel; scoped notes are visible from any session of that scope.
- 🔍 **Filterable panel** — toggle between All / current directory / current session, with live counts.
- 📤 **Send to composer** — append a note (content + quoted source) to the current input draft, ready to send.
- 👀 **View-first popup** — clicking a highlight opens the note read-only; editing is an explicit action.
- 🔄 **Self-healing highlights** — MutationObserver + 5s reconciliation re-apply highlights after re-renders, virtualization, or pagination.
- 💾 **Durable storage** — plain JSON at `~/.dsh/storages/session-notes/notes.json`; fs-service write with shell fallback, serialized queue.

## Install / 安装

This is a **dynamic Cordis plugin** for DSH. It runs in your current `dsh web` process — no build step, no npm.

1. Clone or download this repo.
2. Open a DSH session (创造模式 / cordis preset — the one with `cordis_define` / `cordis_run` tools) and ask the agent:

   > 帮我安装这个插件:仓库 https://github.com/iptton-ai/dsh-plugin-session-notes。
   > 用 cordis_define 定义(读取 src/host.js 作为 code.host、src/client.js 作为 code.client,plugin id 前缀 snote),
   > 然后 cordis_run 激活并批准。

   Or, if you prefer doing it by hand: paste the two function bodies from `src/host.js` and `src/client.js` into `cordis_define`'s `code.host` / `code.client`, then `cordis_run` the returned package and approve it in the UI.

3. Refresh the page, open a session, and select some message text.

> Dynamic plugins live for the lifetime of the `dsh web` process. After a DSH restart, re-run step 2 (your notes on disk are kept).

## How it works / 工作原理

| Piece | Where | What |
| --- | --- | --- |
| Zero-DOM highlight engine | `src/client.js` | Matches each note's quote against the message flow with whitespace-folding + **gap-aware text assembly** (block/`<br>` boundaries insert `\n`, inline-adjacent nodes join seamlessly — mirrors `Selection.toString()`), then registers `Range`s into `CSS.highlights` (`::highlight(snote-hl)`). Falls back to `<mark>` wrapping on engines without the Highlight API. |
| Message-flow anchor | `src/client.js` | A hidden entry in the `conversation.composer.dock` slot walks up to the scroll container — no product class names, no DOM replacement. |
| Side panel / popups / selection button | `src/client.js` | Additive slot entries only: `shell.overlay`, `conversation.session.header.utilities`. |
| Persistence | `src/host.js` | Package-private RPC (`notes/list|add|update|delete|diag`) over `harness.handle`; stores JSON under `~/.dsh/storages/session-notes/`; per-call `danger-full-access` sandbox policy for its own storage file (the default `workspace-write` fence excludes `~/.dsh`). |

## Scope of the sandbox note

The host half explicitly passes `sandboxPolicy: { mode: 'danger-full-access' }` **only for its own storage file** (`~/.dsh/storages/session-notes/notes.json`), because the deployment-default `workspace-write` fence does not include the DSH home directory. The plugin never touches other paths.

## License

MIT
