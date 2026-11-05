// opencode hook service. Unlike claude/gemini (JSON settings merge) and codex (hooks.json +
// trust hash), opencode's hook seam is its PLUGIN system: JS modules in
// ~/.config/opencode/plugins/ whose hooks fire on session/tool/permission events.
// nodeterm owns its plugin file outright (marker-gated — a user's own file is never touched).
// opencode loads plugins on EVERY CLI command, so the plugin is env-gated: without the
// NODETERM_* env of a nodeterm-spawned session it does nothing.
//
// ONE consolidated plugin serves BOTH generations (issue #1136, consolidated 2026-11-05):
// plugins/nodeterm-status.js with a default export { id, server, setup } — v1 calls server()
// and pushes the returned hooks bag (object entrypoints are documented from v1 1.18.29 and
// verified in the 1.18.29 loader source: auto-discovery loads {plugin,plugins}/*.{ts,js}
// FILES only, a default OBJECT engages when it carries id+server, and a file-source plugin
// MUST export a string id), v2 calls setup(ctx) (the documented hybrid, "Support V1 and V2
// from one package" — the extra server key rides along). v1 < 1.18.29 — including the
// <= 1.2.10 build that called every export as a function and crashed on an object default —
// is out of nodeterm's support window by decision: the floor was raised rather than keep two
// artifacts per machine. Which loader generation runs the file decides ITSELF at load time,
// so installation is a plain synchronous plant (installOpencodeHooks below).
//
// LEGACY LAYOUT: pre-consolidation nodeterm planted TWO artifacts — the 1.x named-export file
// (this same primary path) plus a nodeterm-status-v2/ DIRECTORY for 2.x, gated on a version
// probe of the installed CLI. installOpencodeHooks migrates that layout away marker-safely;
// removeOpencodeHooks still cleans both. See their docstrings for the exact policy.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseEndpointEnv } from '../hook-endpoint-parse'

export const PLUGIN_MARKER = '// nodeterm managed plugin — do not edit (reinstalled at app launch)'

/** opencode is XDG-respecting: its config dir is $XDG_CONFIG_HOME/opencode when the env var
 *  is set (Linux/Server Edition users do this), else ~/.config/opencode. */
export function opencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg && path.isAbsolute(xdg)
    ? path.join(xdg, 'opencode')
    : path.join(os.homedir(), '.config', 'opencode')
}

/** The managed plugin file — auto-discovered by both generations (v1's glob loads
 *  `{plugin,plugins}/*.{ts,js}` FILES; v2 loads `plugins/*.js` files and directories). */
export function pluginPath(): string {
  return path.join(opencodeConfigDir(), 'plugins', 'nodeterm-status.js')
}

/** The LEGACY OpenCode 2.x plugin DIRECTORY planted by pre-consolidation nodeterm builds.
 *  Kept only as a migration/removal target — the consolidated plugin never plants it again. */
export function legacyV2PluginDir(): string {
  return path.join(opencodeConfigDir(), 'plugins', 'nodeterm-status-v2')
}

/** The legacy directory's index — the file the old 2.x builder wrote. */
export function legacyV2PluginPath(): string {
  return path.join(legacyV2PluginDir(), 'index.js')
}

/** Which API armed in this process. Both adapters live in ONE module now, and a process
 *  normally runs only one generation's loader — but the latch still guards the edges: a 2.x
 *  that ever grows a v1 compatibility layer, or one process loading the module more than once
 *  (one plugin instance per project directory). The first API to arm owns the process and the
 *  other stays inert, so no build posts every event twice. Keyed by API, not by call: one
 *  process may arm the same API more than once. */
const LATCH = "Symbol.for('nodeterm.opencode.status.api')"

/** The shared poster, embedded verbatim in the plugin (BOTH adapters use it). Mirrors the
 *  managed POSIX script's wire contract exactly (see managed-script.ts + hook-server.ts):
 *  - gate on NODETERM_NODE_ID (absent outside nodeterm-spawned sessions → no poster);
 *  - per POST, re-read the NODETERM_HOOK_ENDPOINT FILE (KEY=VALUE lines) for the LIVE
 *    port/token — tmux sessions outlive the app, so env-baked coords go stale after a
 *    restart (the restart handoff); fall back to the env vars;
 *  - POST application/x-www-form-urlencoded `nodeId` + `version` + `payload` (JSON) with
 *    the x-nodeterm-hook-token header to http://127.0.0.1:<port>/hook/opencode.
 *  Transport: an SSH host advertises a UNIX SOCKET (NODETERM_HOOK_SOCK, no PORT line in the
 *  endpoint file) — the socket wins over TCP, like the POSIX script's `curl --unix-socket`
 *  branch. opencode runs on Bun, whose fetch takes a `unix` option; the node:http
 *  socketPath fallback covers any non-Bun runtime (and is what the tests exercise). */
function sharedPrelude(): string {
  return `import fs from 'node:fs'
import http from 'node:http'

// The SAME quote-aware parser every TS consumer of the endpoint file uses, embedded verbatim
// (this plugin runs standalone under Bun/node — it cannot import from the app). Values are
// posixQuote'd since #351; a quote-blind read would present a token wrapped in literal quotes,
// which the hook server's constant-time bearer check rejects on every POST.
const parseEndpointEnv = ${parseEndpointEnv.toString()}

const LATCH = ${LATCH}
// true when this API may arm: nothing armed yet, or this same API armed first.
const claim = (api) => {
  const owner = globalThis[LATCH]
  if (owner && owner !== api) return false
  globalThis[LATCH] = api
  return true
}

const makePoster = () => {
  const nodeId = process.env.NODETERM_NODE_ID
  if (!nodeId) return null
  const live = () => {
    const conf = {
      port: process.env.NODETERM_HOOK_PORT,
      sock: process.env.NODETERM_HOOK_SOCK,
      token: process.env.NODETERM_HOOK_TOKEN,
      version: process.env.NODETERM_HOOK_VERSION,
      tokenDir: process.env.NODETERM_NODE_TOKEN_DIR
    }
    try {
      const file = process.env.NODETERM_HOOK_ENDPOINT
      if (file) {
        const env = parseEndpointEnv(fs.readFileSync(file, 'utf8'))
        if ('NODETERM_HOOK_PORT' in env) conf.port = env.NODETERM_HOOK_PORT
        if ('NODETERM_HOOK_SOCK' in env) conf.sock = env.NODETERM_HOOK_SOCK
        if ('NODETERM_HOOK_TOKEN' in env) conf.token = env.NODETERM_HOOK_TOKEN
        if ('NODETERM_HOOK_VERSION' in env) conf.version = env.NODETERM_HOOK_VERSION
        // The v2 endpoint line: where this instance keeps per-node tokens.
        if ('NODETERM_NODE_TOKEN_DIR' in env) conf.tokenDir = env.NODETERM_NODE_TOKEN_DIR
      }
    } catch {}
    return conf
  }
  // The PER-NODE capability, read fresh per POST from <dir>/<nodeId> — a lookup by name, never a
  // scan, so this session can only ever present its own. Missing (pre-v2 endpoint, a node whose
  // token was never materialised) is an ordinary state: the header goes out EMPTY and the server
  // reads that as legacy, exactly like every client that predates this.
  const nodeToken = (dir) => {
    try {
      if (!dir) return ''
      return fs.readFileSync(dir + '/' + nodeId, 'utf8').split('\\n')[0].trim()
    } catch {
      return ''
    }
  }
  return (event, extra) => {
    try {
      const { port, sock, token, version, tokenDir } = live()
      if (!token || (!sock && !port)) return
      const payload = JSON.stringify({ event, ...extra })
      const headers = {
        'content-type': 'application/x-www-form-urlencoded',
        'x-nodeterm-hook-token': token,
        'x-nodeterm-node-token': nodeToken(tokenDir)
      }
      const body =
        'nodeId=' + encodeURIComponent(nodeId) +
        '&version=' + encodeURIComponent(version || '') +
        '&payload=' + encodeURIComponent(payload)
      if (sock && typeof Bun !== 'undefined') {
        fetch('http://localhost/hook/opencode', { method: 'POST', unix: sock, headers, body }).catch(() => {})
      } else if (sock) {
        const req = http.request(
          { socketPath: sock, path: '/hook/opencode', method: 'POST', headers },
          (res) => res.resume()
        )
        req.on('error', () => {})
        req.end(body)
      } else {
        fetch('http://127.0.0.1:' + port + '/hook/opencode', { method: 'POST', headers, body }).catch(() => {})
      }
    } catch {}
  }
}
`
}

/** The managed OpenCode status plugin — ONE consolidated file serving BOTH plugin generations
 *  (the documented hybrid, opencode.ai/v2/docs/build/plugins/migrate-v1, "Support V1 and V2
 *  from one package"):
 *  - v1 >= 1.18.29 calls `default.server()` and pushes the returned hooks bag. Verified in the
 *    1.18.29 loader source: a default OBJECT engages when it carries `id` + `server`, and a
 *    file-source plugin MUST export a string `id` — hence `id: 'nodeterm-status'`.
 *  - v2 calls `default.setup(ctx)` (the v2.2.5 Module schema is the `{ id, setup }` struct;
 *    the extra `server` key is exactly the documented hybrid shape).
 *  Both adapters embed the poster/prelude ONCE (sharedPrelude above) and arbitrate through
 *  the per-API LATCH if both ever arm in one process.
 *
 *  V1 adapter (the hooks bag `server()` returns): bus events (session.created/idle/error,
 *  message.updated, permission.updated/replied) reach a plugin ONLY through the `event`
 *  catch-all hook as { event: { type, properties } } — opencode never calls a hook keyed by
 *  the event name itself, so per-event-name exports are dead code (the bug that made every
 *  status silently missing). `tool.execute.before` is the exception: it IS a real named
 *  plugin hook. The event NAME posted is the contract with normalizeOpencode
 *  (permission.updated is posted as `permission.asked`); sessionID/role are extracted
 *  defensively per the SDK payload shapes. message.updated forwards ONLY user messages (turn
 *  start) and only ONCE per messageID: measured on 1.18.3 (TUI), the user message record is
 *  updated again after session.idle (title/bookkeeping), and re-forwarding that as a turn
 *  start resurrected `working` right after `done` (newTurn bypasses the done-holdoff by
 *  design), pinning the node on RUNNING forever.
 *
 *  V2 adapter (`setup(ctx)`, MEASURED on @opencode/cli 2.0.30, TUI and `run`, both
 *  `--standalone`): setup runs in the SERVER process; `ctx.event.subscribe()` is an async
 *  iterable of `{ id, created, type, location, data }`; `ctx.tool.hook('execute.before', cb)`
 *  hands cb `{ tool, sessionID, … }` and fires BEFORE that call's permission.asked. A turn is
 *  `session.execution.started` … `session.execution.succeeded | failed | interrupted` (Esc) —
 *  there is no `session.idle` any more; questions are forms (`form.created` carries the
 *  session under `data.form`, `form.replied|cancelled` under `data`); `session.created`
 *  carries `parentID` for a subagent's child session. Every event is translated to the 1.x
 *  wire names above, so normalizeOpencode has one dialect: execution.started →
 *  message.updated (user), succeeded|interrupted → session.idle, failed → session.error,
 *  form.* → question.*.
 *
 *  THE SHARED SERVER: by default every 2.x CLI talks to ONE background server (`serve
 *  --service`) that keeps the environment of whichever pane started it and outlives it
 *  (MEASURED: a second pane's events ran under the first pane's NODETERM_NODE_ID). setup()
 *  arms wherever it is loaded — 2.x loads plugins ONLY in serve processes (measured in the
 *  field across 2.1.3–2.2.5, Nov 2026), so every long-lived server on a nodeterm machine is
 *  the managed `serve --service`, and stepping aside there would leave no subscriber anywhere
 *  — the badge froze (the regression this arming rule fixed). Posts carry the server's own
 *  NODETERM_NODE_ID (the pane that started it), so multi-pane attribution is imprecise while
 *  a single active pane is exact — the trade the 1.x plugin made before 2.x, accepted over a
 *  dead badge. setup() returns a cleanup that aborts the subscription (the v1 `dispose`
 *  analogue). */
export function buildOpencodePlugin(): string {
  return `${PLUGIN_MARKER}
// OpenCode status plugin for BOTH generations — the documented hybrid ("Support V1 and V2
// from one package"): v1 (>= 1.18.29, where object entrypoints landed) calls default.server()
// and pushes the returned hooks bag; v2 calls default.setup(ctx). A process runs only ONE of
// them; the latch below keeps one poster per process even if both ever arm.
${sharedPrelude()}
// The v1 hooks bag. Bus events reach a plugin ONLY through the \`event\` catch-all as
// { event: { type, properties } } — never through a hook named after the event. message.updated
// forwards only user messages, once per messageID (see the builder's docstring: a post-idle
// bookkeeping touch must not resurrect a finished turn).
const v1Hooks = async () => {
  const post = makePoster()
  if (!post) return {}
  if (!claim('v1')) return {}
  const seenUserMsgs = new Set()
  return {
    event: async (input) => {
      const ev = input && input.event
      if (!ev || !ev.type) return
      const p = ev.properties || {}
      const info = p.info || {}
      switch (ev.type) {
        case 'session.created':
          return post('session.created', { sessionID: info.id || p.sessionID })
        case 'session.idle':
        case 'session.error':
          return post(ev.type, { sessionID: p.sessionID })
        case 'permission.updated':
          return post('permission.asked', { sessionID: p.sessionID })
        case 'permission.replied':
          return post('permission.replied', { sessionID: p.sessionID })
        // The question (elicitation) dialog blocks the turn WITHOUT idling the session —
        // unforwarded, the badge sat on RUNNING while the TUI waited for an answer.
        case 'question.asked':
        case 'question.replied':
        case 'question.rejected':
          return post(ev.type, { sessionID: p.sessionID })
        case 'message.updated': {
          if ((info.role || p.role) !== 'user') return
          if (info.id) {
            if (seenUserMsgs.has(info.id)) return
            seenUserMsgs.add(info.id)
            if (seenUserMsgs.size > 500) {
              for (const first of seenUserMsgs) { seenUserMsgs.delete(first); break }
            }
          }
          return post('message.updated', { sessionID: info.sessionID || p.sessionID, role: 'user' })
        }
      }
    },
    'tool.execute.before': async (input) =>
      post('tool.execute.before', { sessionID: input && input.sessionID })
  }
}

// The v2 event stream, translated to the v1 wire names (normalizeOpencode has one dialect).
// A subagent runs in a CHILD session (session.created carries parentID). Its turn boundaries are
// not the node's — a child's execution.started would re-key the node to the child's session and
// its succeeded would read as the node going idle mid-turn — but a child's permission or form
// DOES block the node's work, so those are forwarded under the root session id.
const translate = (post, children) => {
  const root = (id) => {
    let cur = id
    for (let i = 0; i < 16 && cur && children.has(cur); i++) cur = children.get(cur)
    return cur
  }
  return (ev) => {
    if (!ev || typeof ev.type !== 'string') return
    const d = ev.data || {}
    const sid = typeof d.sessionID === 'string' ? d.sessionID : undefined
    switch (ev.type) {
      case 'session.created':
        if (sid && typeof d.parentID === 'string' && d.parentID) {
          children.set(sid, d.parentID)
          if (children.size > 500) {
            for (const first of children.keys()) { children.delete(first); break }
          }
          return
        }
        return post('session.created', { sessionID: sid })
      case 'session.execution.started':
        if (sid && children.has(sid)) return
        return post('message.updated', { sessionID: sid, role: 'user' })
      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
        if (sid && children.has(sid)) return
        return post('session.idle', { sessionID: sid })
      case 'session.execution.failed':
        if (sid && children.has(sid)) return
        return post('session.error', { sessionID: sid })
      case 'permission.asked':
      case 'permission.replied':
        return post(ev.type, { sessionID: root(sid) })
      case 'form.created': {
        const f = d.form || {}
        return post('question.asked', { sessionID: root(typeof f.sessionID === 'string' ? f.sessionID : sid) })
      }
      case 'form.replied':
        return post('question.replied', { sessionID: root(sid) })
      case 'form.cancelled':
        return post('question.rejected', { sessionID: root(sid) })
    }
  }
}

export default {
  id: 'nodeterm-status',
  async server() {
    return v1Hooks()
  },
  async setup(ctx) {
    if (!ctx || !ctx.event || typeof ctx.event.subscribe !== 'function') return
    const post = makePoster()
    if (!post) return
    if (!claim('v2')) return
    const children = new Map()
    const onEvent = translate(post, children)
    const controller = new AbortController()
    ;(async () => {
      for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
        try { onEvent(ev) } catch {}
      }
    })().catch(() => {})
    try {
      if (ctx.tool && typeof ctx.tool.hook === 'function') {
        // A throw here would FAIL the tool call (execute.before may reject one) — never throw.
        await ctx.tool.hook('execute.before', (input) => {
          try {
            const sid = input && input.sessionID
            if (sid && children.has(sid)) return
            post('tool.execute.before', { sessionID: sid })
          } catch {}
        })
      }
    } catch {}
    return () => controller.abort()
  }
}
`
}

/** Write `body` to `file` unless a file WITHOUT our marker is there (a user's own — never
 *  touched; the read follows symlinks, so a user's link to their own file is equally safe).
 *  A byte-identical body is not rewritten: opencode 2.x watches plugin files and reloads on
 *  change, so an unchanged second install must not touch mtime. */
function plantManaged(file: string, body: string): void {
  try {
    const existing = fs.readFileSync(file, 'utf8')
    if (!existing.startsWith(PLUGIN_MARKER)) return
    if (existing === body) return
  } catch {
    /* absent — plant it */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, 'utf8')
}

/** Remove `file` only when it is marker-managed. Deletions act on the path itself: a symlink
 *  goes, the file it points at never does (fs.rmSync does not follow links). */
function removeManaged(file: string): void {
  try {
    if (fs.readFileSync(file, 'utf8').startsWith(PLUGIN_MARKER)) fs.rmSync(file, { force: true })
  } catch {
    /* absent — nothing to remove */
  }
}

/**
 * Install (or refresh) the consolidated managed plugin, and complete the migration off the
 * legacy two-artifact layout an older nodeterm planted (the 1.x named-export file + the
 * nodeterm-status-v2/ directory). Synchronous: WHICH loader generation runs the file decides
 * itself at load time (v1 calls server(), v2 calls setup), so there is nothing to probe for
 * and nothing to await.
 *
 * Order and policy (each branch tested):
 *  1. If the primary path holds a file WITHOUT our marker (the user's own), touch NOTHING and
 *     return — not their file, and not a marker-managed legacy v2 index either: consolidated
 *     cannot be installed there, and removing the legacy plugin would strand the badge on a
 *     2.x machine nodeterm previously served (on 1.x the legacy directory costs nothing —
 *     the v1.18.29 glob loads files only). The next install after the user removes their own
 *     file completes the migration lazily.
 *  2. Otherwise retire the legacy v2 artifacts FIRST — marker-gated index removal, then
 *     rmdir of the directory only when empty — BEFORE planting, so no 2.x process ever runs
 *     two same-id plugins at once.
 *  3. Plant/refresh the consolidated file at the primary path (marker-gated; byte-identical
 *     writes are skipped, so a second install never touches mtime — 2.x reloads on change).
 */
export function installOpencodeHooks(): void {
  try {
    const primary = fs.readFileSync(pluginPath(), 'utf8')
    if (!primary.startsWith(PLUGIN_MARKER)) return
  } catch {
    /* absent — the path is free; plant below */
  }
  removeManaged(legacyV2PluginPath())
  try {
    // The directory is ours by name; drop it only when nothing of anyone else's is left in it.
    fs.rmdirSync(legacyV2PluginDir())
  } catch {
    /* absent, or not empty (a user's file survives) — leave it */
  }
  plantManaged(pluginPath(), buildOpencodePlugin())
}

/** Remove everything nodeterm manages at BOTH the consolidated path and the legacy ones —
 *  marker-gated everywhere, so a user's own file at either location survives, and deletions
 *  act on a symlink itself, never the file it points at. */
export function removeOpencodeHooks(): void {
  removeManaged(pluginPath())
  removeManaged(legacyV2PluginPath())
  try {
    fs.rmdirSync(legacyV2PluginDir())
  } catch {
    /* absent, or not empty — leave it */
  }
}
