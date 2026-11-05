import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_MARKER,
  buildOpencodePlugin,
  installOpencodeHooks,
  legacyV2PluginDir,
  legacyV2PluginPath,
  opencodeConfigDir,
  pluginPath,
  removeOpencodeHooks
} from './opencode'
import { normalizeOpencode } from '../../../shared/agents/normalize'

// The generated plugin's adapters share one process-wide latch (which plugin API armed first).
// Every test loads fresh module copies into the SAME process, so the latch is reset before each.
const LATCH = Symbol.for('nodeterm.opencode.status.api')
const g = globalThis as unknown as Record<symbol, unknown>

let tmp: string
beforeEach(() => {
  delete g[LATCH]
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-'))
  vi.spyOn(os, 'homedir').mockReturnValue(tmp)
  // CI runners export XDG_CONFIG_HOME (GitHub Actions: /home/runner/.config), which wins
  // over the mocked homedir in opencodeConfigDir() — the installer then writes outside the
  // temp dir and every read here misses. Clear it so the homedir fallback is what's tested;
  // the XDG describe block below stubs its own value on top.
  vi.stubEnv('XDG_CONFIG_HOME', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const planted = () => path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status.js')

describe('opencode plugin install', () => {
  it('writes the marker-bearing consolidated plugin (idempotent content)', () => {
    installOpencodeHooks()
    installOpencodeHooks()
    const body = fs.readFileSync(planted(), 'utf8')
    expect(body.startsWith(PLUGIN_MARKER)).toBe(true)
    expect(body).toContain('NODETERM_NODE_ID')
    expect(body).toContain('/hook/opencode')
  })
  it('never overwrites a user file at the primary path', () => {
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.writeFileSync(planted(), '// my own plugin\n')
    installOpencodeHooks()
    expect(fs.readFileSync(planted(), 'utf8')).toBe('// my own plugin\n')
  })
  it('remove deletes only a marker-bearing file at the primary path', () => {
    installOpencodeHooks()
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(false)
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.writeFileSync(planted(), '// my own plugin\n')
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(true)
  })
  it('generated plugin is env-gated and fail-open', () => {
    const body = buildOpencodePlugin()
    expect(body).toContain('return {}') // missing env → no-op
    expect(body).toContain('catch') // POSTs never throw into opencode
  })
})

// Execute the generated plugin body against SDK-shaped inputs. opencode delivers bus
// events (session.created/idle/error, message.updated, permission.*) ONLY through the
// `event` catch-all hook — a hook keyed by the event name itself is never called (the
// original bug: every handler was dead, so no status ever reached the hook server).
describe('generated plugin behavior (executed)', () => {
  let posts: Array<{ url: string; payload: Record<string, unknown>; nodeId: string }>

  async function loadHooks(): Promise<Record<string, (input: unknown) => Promise<void>>> {
    posts = []
    vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
      const params = new URLSearchParams(init.body)
      posts.push({
        url,
        nodeId: params.get('nodeId') ?? '',
        payload: JSON.parse(params.get('payload') ?? '{}')
      })
      return Promise.resolve(new Response())
    })
    vi.stubEnv('NODETERM_NODE_ID', 'node-1')
    vi.stubEnv('NODETERM_HOOK_PORT', '43210')
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    // A developer may be running this test from a live nodeterm PTY. Never let the
    // generated plugin inherit that session's socket and post test events to it.
    vi.stubEnv('NODETERM_HOOK_SOCK', '')
    const file = path.join(tmp, `plugin-under-test-${Math.random().toString(36).slice(2)}.mjs`)
    fs.writeFileSync(file, buildOpencodePlugin())
    const mod = await import(/* @vite-ignore */ `file://${file}`)
    // The v1 dispatch the 1.18.29 loader performs: hooks.push(await plugin.server(input, …)).
    return mod.default.server()
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('forwards bus events through the `event` catch-all with the wire-contract names', async () => {
    const hooks = await loadHooks()
    expect(typeof hooks.event).toBe('function')

    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_1' } } } })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    await hooks.event({ event: { type: 'session.error', properties: { sessionID: 'ses_1' } } })
    await hooks.event({ event: { type: 'permission.updated', properties: { id: 'perm1', sessionID: 'ses_1' } } })
    await hooks.event({
      event: { type: 'permission.replied', properties: { sessionID: 'ses_1', permissionID: 'perm1', response: 'once' } }
    })
    // The question (elicitation) flow, measured on 1.18.3: the TUI dialog blocks the turn
    // but the session never goes idle, so without these the badge sat on RUNNING.
    await hooks.event({
      event: { type: 'question.asked', properties: { id: 'que_1', sessionID: 'ses_1', questions: [] } }
    })
    await hooks.event({
      event: { type: 'question.replied', properties: { sessionID: 'ses_1', requestID: 'que_1', answers: [['Red']] } }
    })
    await hooks.event({
      event: { type: 'question.rejected', properties: { sessionID: 'ses_1', requestID: 'que_1' } }
    })

    expect(posts.map((p) => p.payload)).toEqual([
      { event: 'session.created', sessionID: 'ses_1' },
      { event: 'session.idle', sessionID: 'ses_1' },
      { event: 'session.error', sessionID: 'ses_1' },
      { event: 'permission.asked', sessionID: 'ses_1' },
      { event: 'permission.replied', sessionID: 'ses_1' },
      { event: 'question.asked', sessionID: 'ses_1' },
      { event: 'question.replied', sessionID: 'ses_1' },
      { event: 'question.rejected', sessionID: 'ses_1' }
    ])
    expect(posts[0].url).toBe('http://127.0.0.1:43210/hook/opencode')
    expect(posts[0].nodeId).toBe('node-1')
  })

  it('forwards message.updated only for user messages (turn start)', async () => {
    const hooks = await loadHooks()
    await hooks.event({
      event: { type: 'message.updated', properties: { info: { id: 'm1', sessionID: 'ses_1', role: 'user' } } }
    })
    await hooks.event({
      event: { type: 'message.updated', properties: { info: { id: 'm2', sessionID: 'ses_1', role: 'assistant' } } }
    })
    expect(posts.map((p) => p.payload)).toEqual([{ event: 'message.updated', sessionID: 'ses_1', role: 'user' }])
  })

  it('posts a user message.updated ONCE per messageID — later updates of the same message are not new turns', async () => {
    // Measured on opencode 1.18.3 (TUI): the user message record is updated again both at
    // turn start (created → completed) and AFTER session.idle (title/bookkeeping touch).
    // Each re-forward became working+newTurn, which bypasses the done-holdoff by design —
    // so the node bounced back to RUNNING right after done and stuck there forever.
    const hooks = await loadHooks()
    const user = (id: string) => ({
      event: { type: 'message.updated', properties: { info: { id, sessionID: 'ses_1', role: 'user' } } }
    })
    await hooks.event(user('m1'))
    await hooks.event(user('m1')) // turn-start double fire
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    await hooks.event(user('m1')) // post-idle bookkeeping touch — must NOT resurrect the turn
    await hooks.event(user('m2')) // a genuinely new prompt still counts
    expect(posts.map((p) => p.payload)).toEqual([
      { event: 'message.updated', sessionID: 'ses_1', role: 'user' },
      { event: 'session.idle', sessionID: 'ses_1' },
      { event: 'message.updated', sessionID: 'ses_1', role: 'user' }
    ])
  })

  it('ignores unrelated bus events (token-stream deltas never reach the hook server)', async () => {
    const hooks = await loadHooks()
    await hooks.event({ event: { type: 'message.part.delta', properties: {} } })
    await hooks.event({ event: { type: 'session.updated', properties: { info: { id: 'ses_1' } } } })
    expect(posts).toEqual([])
  })

  it('posts tool.execute.before from the real plugin hook of that name', async () => {
    const hooks = await loadHooks()
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_1', callID: 'c1' })
    expect(posts.map((p) => p.payload)).toEqual([{ event: 'tool.execute.before', sessionID: 'ses_1' }])
  })
})

// SSH hosts advertise a UNIX SOCKET (NODETERM_HOOK_SOCK), not a TCP port — the endpoint
// file on a remote host has no PORT line at all. The POSIX managed script posts with
// `curl --unix-socket`; the plugin must speak the socket too or every opencode status
// on an SSH project silently vanishes (fetch can't do unix sockets in Node — node:http
// socketPath is the fallback; under Bun (opencode's runtime) fetch takes `unix`).
describe('generated plugin unix-socket transport', () => {
  let sockDir: string
  beforeEach(() => {
    sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-sock-'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fs.rmSync(sockDir, { recursive: true, force: true })
  })

  async function importPlugin(): Promise<Record<string, (input: unknown) => Promise<void>>> {
    const file = path.join(tmp, `plugin-sock-${Math.random().toString(36).slice(2)}.mjs`)
    fs.writeFileSync(file, buildOpencodePlugin())
    const mod = await import(/* @vite-ignore */ `file://${file}`)
    return mod.default.server()
  }

  it('posts over the unix socket via node:http when NODETERM_HOOK_SOCK is set (no port)', async () => {
    const { createServer } = await import('node:http')
    const sock = path.join(sockDir, 'hook.sock')
    const received: Array<{ url: string; token: string; body: string }> = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c))
      req.on('end', () => {
        received.push({ url: req.url ?? '', token: String(req.headers['x-nodeterm-hook-token']), body })
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    try {
      vi.stubEnv('NODETERM_NODE_ID', 'node-ssh')
      vi.stubEnv('NODETERM_HOOK_SOCK', sock)
      vi.stubEnv('NODETERM_HOOK_TOKEN', 'socktok')
      vi.stubEnv('NODETERM_HOOK_PORT', '')
      vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
      const hooks = await importPlugin()
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_ssh' } } })
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(received[0].url).toBe('/hook/opencode')
      expect(received[0].token).toBe('socktok')
      const params = new URLSearchParams(received[0].body)
      expect(params.get('nodeId')).toBe('node-ssh')
      expect(JSON.parse(params.get('payload') ?? '{}')).toEqual({ event: 'session.idle', sessionID: 'ses_ssh' })
    } finally {
      server.close()
    }
  })

  it('reads NODETERM_HOOK_SOCK from the live endpoint file (restart handoff) and prefers it over a TCP port', async () => {
    const { createServer } = await import('node:http')
    const sock = path.join(sockDir, 'hook2.sock')
    const received: string[] = []
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        received.push(req.url ?? '')
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    const tcpFetch = vi.fn(() => Promise.resolve(new Response()))
    vi.stubGlobal('fetch', tcpFetch)
    try {
      const envFile = path.join(sockDir, 'hook-endpoint.env')
      fs.writeFileSync(envFile, `NODETERM_HOOK_SOCK=${sock}\nNODETERM_HOOK_TOKEN=filetok\nNODETERM_HOOK_VERSION=1\n`)
      vi.stubEnv('NODETERM_NODE_ID', 'node-ssh')
      vi.stubEnv('NODETERM_HOOK_ENDPOINT', envFile)
      vi.stubEnv('NODETERM_HOOK_PORT', '59999') // stale env port — socket from the file must win
      vi.stubEnv('NODETERM_HOOK_TOKEN', 'stale')
      vi.stubEnv('NODETERM_HOOK_SOCK', '')
      const hooks = await importPlugin()
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_ssh' } } })
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(tcpFetch).not.toHaveBeenCalled()
    } finally {
      server.close()
    }
  })

  it('uses Bun fetch with the `unix` option when running under Bun', async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = []
    vi.stubGlobal('Bun', {})
    vi.stubGlobal('fetch', (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init })
      return Promise.resolve(new Response())
    })
    vi.stubEnv('NODETERM_NODE_ID', 'node-ssh')
    vi.stubEnv('NODETERM_HOOK_SOCK', '/tmp/some.sock')
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
    vi.stubEnv('NODETERM_HOOK_PORT', '')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    const hooks = await importPlugin()
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_ssh' } } })
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('http://localhost/hook/opencode')
    expect(calls[0].init.unix).toBe('/tmp/some.sock')
  })
})

// The per-node token (task A10). The plugin is the one client that is not sh: it must learn the
// token dir from the SAME endpoint file (a new KEY=VALUE line the file's regex has to accept),
// read `<dir>/<nodeId>`, and put the header on BOTH transports — the Bun `fetch` (TCP and unix)
// and the node:http socketPath fallback.
describe('generated plugin presents the per-node token', () => {
  let tokenDir: string
  let sockDir: string

  beforeEach(() => {
    tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-tok-'))
    sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-tsock-'))
    fs.writeFileSync(path.join(tokenDir, 'node-1'), 'OPENCODE-NODE-TOKEN\n', { mode: 0o600 })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fs.rmSync(tokenDir, { recursive: true, force: true })
    fs.rmSync(sockDir, { recursive: true, force: true })
  })

  async function importPlugin(): Promise<Record<string, (input: unknown) => Promise<void>>> {
    const file = path.join(tmp, `plugin-token-${Math.random().toString(36).slice(2)}.mjs`)
    fs.writeFileSync(file, buildOpencodePlugin())
    const mod = await import(/* @vite-ignore */ `file://${file}`)
    return mod.default.server()
  }

  /** Fires one event over the plain TCP `fetch` path and returns the headers it sent. */
  async function tcpHeaders(env: Record<string, string>): Promise<Record<string, string>> {
    const calls: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers)
      return Promise.resolve(new Response())
    })
    vi.stubEnv('NODETERM_NODE_ID', 'node-1')
    vi.stubEnv('NODETERM_HOOK_PORT', '43210')
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    vi.stubEnv('NODETERM_HOOK_SOCK', '')
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    const hooks = await importPlugin()
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    expect(calls.length).toBe(1)
    return calls[0]
  }

  it('sends the token on the fetch path when the file exists', async () => {
    const headers = await tcpHeaders({ NODETERM_NODE_TOKEN_DIR: tokenDir })
    expect(headers['x-nodeterm-node-token']).toBe('OPENCODE-NODE-TOKEN')
  })

  it('sends an EMPTY token — and still posts — when there is no token file', async () => {
    const headers = await tcpHeaders({ NODETERM_NODE_TOKEN_DIR: path.join(tokenDir, 'nope') })
    expect(headers['x-nodeterm-node-token']).toBe('')
  })

  it('sends an empty token when no dir is advertised at all (pre-v2 endpoint)', async () => {
    const headers = await tcpHeaders({})
    expect(headers['x-nodeterm-node-token']).toBe('')
  })

  it('never presents ANOTHER node\'s token file — the path is keyed by the node id', async () => {
    const headers = await tcpHeaders({ NODETERM_NODE_TOKEN_DIR: tokenDir, NODETERM_NODE_ID: 'node-9' })
    expect(headers['x-nodeterm-node-token']).toBe('')
  })

  it('learns the dir from the ENDPOINT FILE (the v2 line), not only the env', async () => {
    const envFile = path.join(sockDir, 'hook-endpoint.env')
    fs.writeFileSync(
      envFile,
      `NODETERM_HOOK_PORT=43210\nNODETERM_HOOK_TOKEN=filetok\nNODETERM_HOOK_VERSION=2\nNODETERM_NODE_TOKEN_DIR=${tokenDir}\n`
    )
    const headers = await tcpHeaders({ NODETERM_HOOK_ENDPOINT: envFile, NODETERM_HOOK_PORT: '' })
    expect(headers['x-nodeterm-node-token']).toBe('OPENCODE-NODE-TOKEN')
    expect(headers['x-nodeterm-hook-token']).toBe('filetok')
  })

  it('sends it on the Bun unix-fetch path too', async () => {
    const calls: Array<{ init: Record<string, unknown> }> = []
    vi.stubGlobal('Bun', {})
    vi.stubGlobal('fetch', (_url: string, init: Record<string, unknown>) => {
      calls.push({ init })
      return Promise.resolve(new Response())
    })
    vi.stubEnv('NODETERM_NODE_ID', 'node-1')
    vi.stubEnv('NODETERM_HOOK_SOCK', '/tmp/some.sock')
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
    vi.stubEnv('NODETERM_HOOK_PORT', '')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    vi.stubEnv('NODETERM_NODE_TOKEN_DIR', tokenDir)
    const hooks = await importPlugin()
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    expect(calls.length).toBe(1)
    expect((calls[0].init.headers as Record<string, string>)['x-nodeterm-node-token']).toBe(
      'OPENCODE-NODE-TOKEN'
    )
  })

  it('sends it on the node:http socketPath path too (real unix server)', async () => {
    const { createServer } = await import('node:http')
    const sock = path.join(sockDir, 'hook.sock')
    const received: Array<string> = []
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        received.push(String(req.headers['x-nodeterm-node-token'] ?? ''))
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    try {
      vi.stubEnv('NODETERM_NODE_ID', 'node-1')
      vi.stubEnv('NODETERM_HOOK_SOCK', sock)
      vi.stubEnv('NODETERM_HOOK_TOKEN', 'socktok')
      vi.stubEnv('NODETERM_HOOK_PORT', '')
      vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
      vi.stubEnv('NODETERM_NODE_TOKEN_DIR', tokenDir)
      const hooks = await importPlugin()
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(received[0]).toBe('OPENCODE-NODE-TOKEN')
    } finally {
      server.close()
    }
  })

  it('posts over node:http with an EMPTY token when the file is missing', async () => {
    const { createServer } = await import('node:http')
    const sock = path.join(sockDir, 'hook-empty.sock')
    const received: Array<string> = []
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        received.push(String(req.headers['x-nodeterm-node-token'] ?? ''))
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    try {
      vi.stubEnv('NODETERM_NODE_ID', 'node-1')
      vi.stubEnv('NODETERM_HOOK_SOCK', sock)
      vi.stubEnv('NODETERM_HOOK_TOKEN', 'socktok')
      vi.stubEnv('NODETERM_HOOK_PORT', '')
      vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
      vi.stubEnv('NODETERM_NODE_TOKEN_DIR', path.join(tokenDir, 'nope'))
      const hooks = await importPlugin()
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(received[0]).toBe('')
    } finally {
      server.close()
    }
  })
})

describe('opencodeConfigDir honors XDG_CONFIG_HOME', () => {
  it('lands the plugin under $XDG_CONFIG_HOME/opencode when the (absolute) env var is set', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-xdg-'))
    vi.stubEnv('XDG_CONFIG_HOME', xdg)
    try {
      expect(opencodeConfigDir()).toBe(path.join(xdg, 'opencode'))
      expect(pluginPath()).toBe(path.join(xdg, 'opencode', 'plugins', 'nodeterm-status.js'))
      installOpencodeHooks()
      const body = fs.readFileSync(path.join(xdg, 'opencode', 'plugins', 'nodeterm-status.js'), 'utf8')
      expect(body.startsWith(PLUGIN_MARKER)).toBe(true)
      // and NOT under ~/.config
      expect(fs.existsSync(path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status.js'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(xdg, { recursive: true, force: true })
    }
  })
  it('falls back to ~/.config/opencode when XDG_CONFIG_HOME is unset', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '')
    try {
      expect(opencodeConfigDir()).toBe(path.join(tmp, '.config', 'opencode'))
      expect(pluginPath()).toBe(path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status.js'))
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

// The consolidation migration (floor v1 >= 1.18.29). An older nodeterm planted TWO artifacts: the
// 1.x named-export FILE at plugins/nodeterm-status.js and a 2.x DIRECTORY at
// plugins/nodeterm-status-v2/. The consolidated build plants ONE file at the primary path and
// retires the legacy pair marker-safely. Collision policy (source-verified in research): when the
// primary is the user's OWN file (no marker), consolidated cannot be installed there — a
// marker-managed legacy v2 index is RETAINED, not removed: removing it would strand the badge on
// a 2.x machine nodeterm previously served, while on 1.x the legacy directory costs nothing (the
// v1.18.29 glob loads files only, so a directory is invisible to every 1.x). When the user ever
// removes their own file, the next install completes the migration lazily.
describe('opencode plugin install — consolidated file + legacy two-artifact migration', () => {
  const legacyDir = () => path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status-v2')
  const legacyIndex = () => path.join(legacyDir(), 'index.js')

  /** The two-artifact layout an older nodeterm leaves behind. */
  const plantLegacyLayout = (primaryBody: string, v2Body: string) => {
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.mkdirSync(legacyDir(), { recursive: true })
    fs.writeFileSync(planted(), primaryBody)
    fs.writeFileSync(legacyIndex(), v2Body)
  }

  it('targets the legacy layout at the exact paths an older nodeterm planted', () => {
    expect(legacyV2PluginDir()).toBe(legacyDir())
    expect(legacyV2PluginPath()).toBe(legacyIndex())
  })

  it('installs the consolidated plugin synchronously — no probe, no await', () => {
    installOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(true)
    expect(fs.readFileSync(planted(), 'utf8')).toBe(buildOpencodePlugin())
  })

  it('migrates a managed old-layout pair: primary becomes consolidated, legacy v2 index and directory are removed', () => {
    plantLegacyLayout(PLUGIN_MARKER + '\n// old 1.x body\n', PLUGIN_MARKER + '\n// old 2.x body\n')
    installOpencodeHooks()
    expect(fs.readFileSync(planted(), 'utf8')).toBe(buildOpencodePlugin())
    expect(fs.existsSync(legacyIndex())).toBe(false)
    expect(fs.existsSync(legacyDir())).toBe(false) // removed only when empty
  })

  it('migrates the legacy-only layout a version-gated build left on a known-2.x machine (no primary at all)', () => {
    fs.mkdirSync(legacyDir(), { recursive: true })
    fs.writeFileSync(legacyIndex(), PLUGIN_MARKER + '\n// old 2.x body\n')
    installOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(true)
    expect(fs.readFileSync(planted(), 'utf8')).toBe(buildOpencodePlugin())
    expect(fs.existsSync(legacyDir())).toBe(false)
  })

  it('keeps unrelated contents when retiring the legacy directory (rmdir-if-empty only)', () => {
    plantLegacyLayout(PLUGIN_MARKER + '\n// old 1.x body\n', PLUGIN_MARKER + '\n// old 2.x body\n')
    fs.writeFileSync(path.join(legacyDir(), 'notes.txt'), 'mine')
    installOpencodeHooks()
    expect(fs.existsSync(legacyIndex())).toBe(false)
    expect(fs.readFileSync(path.join(legacyDir(), 'notes.txt'), 'utf8')).toBe('mine')
  })

  it('keeps a user-customized legacy v2 index verbatim (no marker → not ours to remove)', () => {
    plantLegacyLayout(PLUGIN_MARKER + '\n// old 1.x body\n', '// my own v2 plugin\n')
    installOpencodeHooks()
    expect(fs.readFileSync(planted(), 'utf8')).toBe(buildOpencodePlugin())
    expect(fs.readFileSync(legacyIndex(), 'utf8')).toBe('// my own v2 plugin\n')
    expect(fs.existsSync(legacyDir())).toBe(true)
  })

  it("RETAINS a managed legacy v2 plugin when the primary is the user's own file — no stranded badge, nothing of theirs touched", () => {
    // The collision: consolidated cannot be installed at the primary, so removing the legacy v2
    // would strand every 2.x machine nodeterm previously served. Retain it VERBATIM (not even
    // refreshed — one builder only, and a stale body still speaks the current wire contract).
    plantLegacyLayout('// my own plugin\n', PLUGIN_MARKER + '\n// old 2.x body\n')
    installOpencodeHooks()
    expect(fs.readFileSync(planted(), 'utf8')).toBe('// my own plugin\n')
    expect(fs.readFileSync(legacyIndex(), 'utf8')).toBe(PLUGIN_MARKER + '\n// old 2.x body\n')
    expect(fs.existsSync(legacyDir())).toBe(true)
  })

  it("plants nothing at all when the primary is the user's and no legacy v2 exists", () => {
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.writeFileSync(planted(), '// my own plugin\n')
    installOpencodeHooks()
    expect(fs.readFileSync(planted(), 'utf8')).toBe('// my own plugin\n')
    expect(fs.existsSync(legacyDir())).toBe(false)
  })

  it('retains the legacy fallback when a real directory occupies the primary path', () => {
    fs.mkdirSync(legacyDir(), { recursive: true })
    const legacyBody = PLUGIN_MARKER + '\n// old 2.x body\n'
    fs.writeFileSync(legacyIndex(), legacyBody)
    fs.mkdirSync(planted())
    fs.writeFileSync(path.join(planted(), 'notes.txt'), 'mine')

    expect(() => installOpencodeHooks()).toThrow(expect.objectContaining({ code: 'EISDIR' }))
    expect(fs.readFileSync(legacyIndex(), 'utf8')).toBe(legacyBody)
    expect(fs.statSync(legacyDir()).isDirectory()).toBe(true)
    expect(fs.statSync(planted()).isDirectory()).toBe(true)
    expect(fs.readFileSync(path.join(planted(), 'notes.txt'), 'utf8')).toBe('mine')
  })

  it.each(['absent', 'managed'] as const)('retains the legacy fallback when writing the %s primary fails', (primary) => {
    const primaryBody = PLUGIN_MARKER + '\n// old 1.x body\n'
    const legacyBody = PLUGIN_MARKER + '\n// old 2.x body\n'
    plantLegacyLayout(primaryBody, legacyBody)
    if (primary === 'absent') fs.rmSync(planted())
    const write = fs.writeFileSync
    // A targeted filesystem failure is deterministic even when the runner can bypass mode bits.
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (file === planted()) throw Object.assign(new Error('primary write denied'), { code: 'EACCES' })
      return write(file, ...args)
    })

    expect(() => installOpencodeHooks()).toThrow(expect.objectContaining({ code: 'EACCES' }))
    expect(fs.readFileSync(legacyIndex(), 'utf8')).toBe(legacyBody)
    expect(fs.statSync(legacyDir()).isDirectory()).toBe(true)
    if (primary === 'managed') expect(fs.readFileSync(planted(), 'utf8')).toBe(primaryBody)
    else expect(fs.existsSync(planted())).toBe(false)
  })

  it('leaves all data untouched when the canonical file cannot be read for a non-ENOENT reason', () => {
    const primaryBody = '// my own unreadable plugin\n'
    const legacyBody = PLUGIN_MARKER + '\n// old 2.x body\n'
    plantLegacyLayout(primaryBody, legacyBody)
    fs.writeFileSync(path.join(legacyDir(), 'notes.txt'), 'mine')
    const read = fs.readFileSync
    // Inject only the primary read: all fixture data and legacy reads remain real filesystem IO.
    const unreadable = vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (file === planted()) throw Object.assign(new Error('primary read denied'), { code: 'EACCES' })
      return read(file, ...args)
    })

    expect(() => installOpencodeHooks()).toThrow(expect.objectContaining({ code: 'EACCES' }))
    unreadable.mockRestore()
    expect(fs.readFileSync(planted(), 'utf8')).toBe(primaryBody)
    expect(fs.readFileSync(legacyIndex(), 'utf8')).toBe(legacyBody)
    expect(fs.readFileSync(path.join(legacyDir(), 'notes.txt'), 'utf8')).toBe('mine')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'retains the legacy fallback in a real read-only plugins directory',
    () => {
      fs.mkdirSync(legacyDir(), { recursive: true })
      const legacyBody = PLUGIN_MARKER + '\n// old 2.x body\n'
      fs.writeFileSync(legacyIndex(), legacyBody)
      const pluginsDir = path.dirname(planted())
      const mode = fs.statSync(pluginsDir).mode
      fs.chmodSync(pluginsDir, 0o555)
      try {
        expect(() => installOpencodeHooks()).toThrow(expect.objectContaining({ code: 'EACCES' }))
        expect(fs.readFileSync(legacyIndex(), 'utf8')).toBe(legacyBody)
        expect(fs.statSync(legacyDir()).isDirectory()).toBe(true)
        expect(fs.existsSync(planted())).toBe(false)
      } finally {
        // Restore access even on RED so fixture cleanup never leaks a read-only directory.
        fs.chmodSync(pluginsDir, mode)
      }
    }
  )

  it('completes the migration lazily once the user removes their own file', () => {
    plantLegacyLayout('// my own plugin\n', PLUGIN_MARKER + '\n// old 2.x body\n')
    installOpencodeHooks() // retained — the previous test's policy
    fs.rmSync(planted()) // the user deletes their own file
    installOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(true)
    expect(fs.readFileSync(planted(), 'utf8')).toBe(buildOpencodePlugin())
    expect(fs.existsSync(legacyDir())).toBe(false)
  })

  it('does not rewrite an up-to-date consolidated file: a second install preserves its mtime', () => {
    installOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(true)
    const past = Math.floor(Date.now() / 1000) - 60 // whole seconds: mtimeMs is a float
    fs.utimesSync(planted(), past, past)
    installOpencodeHooks()
    expect(Math.round(fs.statSync(planted()).mtimeMs / 1000)).toBe(past)
  })

  it('does not rewrite the migrated consolidated file either (migration, then a second install)', () => {
    plantLegacyLayout(PLUGIN_MARKER + '\n// old 1.x body\n', PLUGIN_MARKER + '\n// old 2.x body\n')
    installOpencodeHooks()
    const past = Math.floor(Date.now() / 1000) - 60
    fs.utimesSync(planted(), past, past)
    installOpencodeHooks()
    expect(Math.round(fs.statSync(planted()).mtimeMs / 1000)).toBe(past)
  })

  it('remove deletes the consolidated file, the legacy v2 index and the empty directory — but never a user file', () => {
    plantLegacyLayout(PLUGIN_MARKER + '\n// old 1.x body\n', PLUGIN_MARKER + '\n// old 2.x body\n')
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(false)
    expect(fs.existsSync(legacyDir())).toBe(false)
    // A user's own primary survives; the managed legacy index beside it still goes.
    plantLegacyLayout('// my own plugin\n', PLUGIN_MARKER + '\n// old 2.x body\n')
    removeOpencodeHooks()
    expect(fs.readFileSync(planted(), 'utf8')).toBe('// my own plugin\n')
    expect(fs.existsSync(legacyIndex())).toBe(false)
    expect(fs.existsSync(legacyDir())).toBe(false)
    // A user's own legacy index survives, and so does the directory holding it.
    plantLegacyLayout(PLUGIN_MARKER + '\n// old 1.x body\n', '// my own v2 plugin\n')
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(false)
    expect(fs.readFileSync(legacyIndex(), 'utf8')).toBe('// my own v2 plugin\n')
    expect(fs.existsSync(legacyDir())).toBe(true)
    // Unrelated contents in the directory survive the index's removal (rmdir-if-empty only).
    plantLegacyLayout(PLUGIN_MARKER + '\n// old 1.x body\n', PLUGIN_MARKER + '\n// old 2.x body\n')
    fs.writeFileSync(path.join(legacyDir(), 'notes.txt'), 'mine')
    removeOpencodeHooks()
    expect(fs.existsSync(legacyIndex())).toBe(false)
    expect(fs.readFileSync(path.join(legacyDir(), 'notes.txt'), 'utf8')).toBe('mine')
  })

  it('remove handles the consolidated-only layout (no legacy directory ever planted)', () => {
    installOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(true)
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(false)
    installOpencodeHooks() // re-enabled after an opt-out: a fresh install plants again
    expect(fs.existsSync(planted())).toBe(true)
  })

  it('remove handles the legacy-only layout (no primary ever planted)', () => {
    fs.mkdirSync(legacyDir(), { recursive: true })
    fs.writeFileSync(legacyIndex(), PLUGIN_MARKER + '\n// old 2.x body\n')
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(false)
    expect(fs.existsSync(legacyDir())).toBe(false)
  })

  // Symlink safety (investigated, expectations kept): reads FOLLOW a user's link — a non-marker
  // target reads as "not ours", so a symlinked user file is never overwritten — while deletions
  // act on the LINK itself (fs.rmSync/fs.rmdirSync never follow into the target), so neither
  // install nor remove can destroy what a link points at.
  describe.skipIf(process.platform === 'win32')('symlinks', () => {
    it('treats a user symlink at the primary path as their own file — link and target untouched', () => {
      const real = path.join(tmp, 'my-real-status.js')
      fs.writeFileSync(real, '// my own plugin\n')
      fs.mkdirSync(path.dirname(planted()), { recursive: true })
      fs.symlinkSync(real, planted())
      installOpencodeHooks()
      expect(fs.lstatSync(planted()).isSymbolicLink()).toBe(true)
      expect(fs.readFileSync(real, 'utf8')).toBe('// my own plugin\n')
    })

    it('remove deletes a marker-managed symlink itself, never the file it points at', () => {
      const real = path.join(tmp, 'managed-real-status.js')
      fs.writeFileSync(real, PLUGIN_MARKER + '\n// old 1.x body\n')
      fs.mkdirSync(path.dirname(planted()), { recursive: true })
      fs.symlinkSync(real, planted())
      removeOpencodeHooks()
      expect(fs.existsSync(planted())).toBe(false) // the LINK is gone
      expect(fs.readFileSync(real, 'utf8')).toBe(PLUGIN_MARKER + '\n// old 1.x body\n') // the file is not
    })
  })
})

describe('the consolidated plugin — module shape and adapters (executed)', () => {
  let posts: Array<Record<string, unknown>>

  beforeEach(() => {
    posts = []
    // Env-stripping, ported from the upstream regression suite: this file may run inside a
    // nodeterm-managed pane whose env carries the REAL hook endpoint/socket/token dir. Stub away
    // EVERY inherited NODETERM_* var first — empty string is falsy everywhere the generated
    // plugin looks — then set only the dummies below, so no case can reach a real endpoint.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('NODETERM_')) vi.stubEnv(key, '')
    }
    vi.stubGlobal('fetch', (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(new URLSearchParams(init.body).get('payload') ?? '{}'))
      return Promise.resolve(new Response())
    })
    vi.stubEnv('NODETERM_NODE_ID', 'node-1')
    vi.stubEnv('NODETERM_HOOK_PORT', '43210')
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    vi.stubEnv('NODETERM_HOOK_SOCK', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  type V1Hooks = Record<string, (input: unknown) => Promise<void>>
  type PluginDef = {
    id: string
    server: () => Promise<V1Hooks>
    setup: (ctx: unknown) => Promise<(() => void) | void>
  }

  async function load(body: string): Promise<Record<string, unknown>> {
    const file = path.join(tmp, `plugin-${Math.random().toString(36).slice(2)}.mjs`)
    fs.writeFileSync(file, body)
    return import(/* @vite-ignore */ `file://${file}`)
  }

  /** Loads the consolidated module and returns its default — asserting the export shape on the
   *  way, so a regression against the hybrid shape fails as a readable diff, not a TypeError. */
  const loadPlugin = async (): Promise<PluginDef> => {
    const mod = await load(buildOpencodePlugin())
    expect(Object.keys(mod)).toEqual(['default'])
    return mod.default as PluginDef
  }

  /** A 2.x context: an event stream we push into, and a tool-hook registry. */
  function v2Context(): {
    ctx: unknown
    push: (type: string, data: Record<string, unknown>) => void
    end: () => void
    toolHooks: Array<{ name: string; cb: (input: unknown) => unknown }>
    subscribed: () => number
    signal: () => AbortSignal | undefined
  } {
    const queue: unknown[] = []
    let wake: (() => void) | null = null
    let done = false
    let subs = 0
    let sig: AbortSignal | undefined
    const toolHooks: Array<{ name: string; cb: (input: unknown) => unknown }> = []
    const ctx = {
      event: {
        subscribe: (options?: { signal?: AbortSignal }) => {
          subs++
          sig = options?.signal
          return {
            async *[Symbol.asyncIterator]() {
              for (;;) {
                if (queue.length) {
                  yield queue.shift()
                  continue
                }
                if (done || sig?.aborted) return
                await new Promise<void>((r) => (wake = r))
              }
            }
          }
        }
      },
      tool: {
        hook: async (name: string, cb: (input: unknown) => unknown) => {
          toolHooks.push({ name, cb })
          return { dispose: () => {} }
        }
      }
    }
    return {
      ctx,
      push: (type, data) => {
        queue.push({ id: 'evt_' + queue.length, created: 1, type, location: { directory: '/p' }, data })
        wake?.()
      },
      end: () => {
        done = true
        wake?.()
      },
      toolHooks,
      subscribed: () => subs,
      signal: () => sig
    }
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('exports exactly a default object — id, server, setup, nothing else', async () => {
    // The documented hybrid (opencode.ai/v2/docs/build/plugins/migrate-v1, "Support V1 and V2
    // from one package"), verified against the v1.18.29 loader: a default OBJECT engages when
    // it carries id+server, and a file-source plugin MUST export a string id. No named exports
    // exist any more — the v1 support floor is 1.18.29, where object entrypoints landed.
    const def = await loadPlugin()
    expect(typeof def).toBe('object')
    expect(typeof def.id).toBe('string')
    expect(def.id).toBe('nodeterm-status')
    expect(typeof def.server).toBe('function')
    expect(typeof def.setup).toBe('function')
  })

  it('v1 dispatch — server() returns the hooks bag the 1.18.29 loader pushes', async () => {
    // The loader does `hooks.push(await plugin.server(input, load.options))`; the bag's members
    // are the hooks, and bus events arrive ONLY through the `event` catch-all.
    const def = await loadPlugin()
    const hooks = await def.server()
    expect(typeof hooks.event).toBe('function')
    expect(typeof hooks['tool.execute.before']).toBe('function')
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    expect(posts).toEqual([{ event: 'session.idle', sessionID: 'ses_1' }])
  })

  it('v1 with no NODETERM_NODE_ID (outside nodeterm) arms nothing', async () => {
    vi.stubEnv('NODETERM_NODE_ID', '')
    const def = await loadPlugin()
    expect(await def.server()).toEqual({})
    expect(g[LATCH]).toBeUndefined()
  })

  it('2.x: translates the event stream to the 1.x wire names normalizeOpencode reads', async () => {
    const def = await loadPlugin()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    expect(v2.subscribed()).toBe(1)
    v2.push('session.created', { sessionID: 'ses_1', projectID: 'p', slug: 's', version: '2.0.30' })
    v2.push('session.inbox.enqueued', { sessionID: 'ses_1' })
    v2.push('session.execution.started', { sessionID: 'ses_1' })
    v2.push('session.text.delta', { sessionID: 'ses_1', delta: 'hi' })
    v2.push('permission.asked', { id: 'per_1', sessionID: 'ses_1', action: 'shell' })
    v2.push('permission.replied', { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' })
    v2.push('form.created', { form: { id: 'frm_1', sessionID: 'ses_1', title: 'Questions' } })
    v2.push('form.replied', { id: 'frm_1', sessionID: 'ses_1', answer: { q0: 'Red' } })
    v2.push('form.created', { form: { id: 'frm_2', sessionID: 'ses_1' } })
    v2.push('form.cancelled', { id: 'frm_2', sessionID: 'ses_1' })
    v2.push('session.execution.succeeded', { sessionID: 'ses_1' })
    v2.push('session.execution.started', { sessionID: 'ses_1' })
    v2.push('session.execution.interrupted', { sessionID: 'ses_1' })
    v2.push('session.execution.started', { sessionID: 'ses_1' })
    v2.push('session.execution.failed', { sessionID: 'ses_1', error: {} })
    await flush()
    expect(posts).toEqual([
      { event: 'session.created', sessionID: 'ses_1' },
      { event: 'message.updated', sessionID: 'ses_1', role: 'user' },
      { event: 'permission.asked', sessionID: 'ses_1' },
      { event: 'permission.replied', sessionID: 'ses_1' },
      { event: 'question.asked', sessionID: 'ses_1' },
      { event: 'question.replied', sessionID: 'ses_1' },
      { event: 'question.asked', sessionID: 'ses_1' },
      { event: 'question.rejected', sessionID: 'ses_1' },
      { event: 'session.idle', sessionID: 'ses_1' },
      { event: 'message.updated', sessionID: 'ses_1', role: 'user' },
      { event: 'session.idle', sessionID: 'ses_1' },
      { event: 'message.updated', sessionID: 'ses_1', role: 'user' },
      { event: 'session.error', sessionID: 'ses_1' }
    ])
    v2.end()
  })

  it('2.x: a real 2.0.30 TUI turn (as captured) normalizes to the same states as a 1.x turn', async () => {
    // The order a measured `opencode --standalone` turn produced: a shell call behind a
    // permission prompt, then a question form, then the end of the turn.
    const def = await loadPlugin()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    const hook = v2.toolHooks[0].cb
    v2.push('session.created', { sessionID: 'ses_1' })
    v2.push('session.execution.started', { sessionID: 'ses_1' })
    await flush()
    hook({ tool: 'shell', sessionID: 'ses_1' })
    v2.push('permission.asked', { id: 'per_1', sessionID: 'ses_1' })
    v2.push('permission.replied', { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' })
    await flush()
    hook({ tool: 'question', sessionID: 'ses_1' })
    v2.push('form.created', { form: { id: 'frm_1', sessionID: 'ses_1' } })
    v2.push('form.replied', { id: 'frm_1', sessionID: 'ses_1', answer: { q0: 'Red' } })
    v2.push('session.execution.succeeded', { sessionID: 'ses_1' })
    await flush()
    const states = posts.map((payload) => {
      const n = normalizeOpencode({ nodeId: 'node-1', agentId: 'opencode', payload })
      return n && (n.kind === 'state' ? n.state + (n.newTurn ? '+newTurn' : '') : n.kind)
    })
    expect(states).toEqual([
      'session',
      'working+newTurn',
      'working',
      'blocked',
      'working',
      'working',
      'blocked',
      'working',
      'done'
    ])
    v2.end()
  })

  it('2.x: the tool hook posts tool.execute.before and never throws into the tool call', async () => {
    const def = await loadPlugin()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    expect(v2.toolHooks.map((h) => h.name)).toEqual(['execute.before'])
    expect(() => v2.toolHooks[0].cb({ tool: 'shell', sessionID: 'ses_1', id: 'call_1' })).not.toThrow()
    expect(() => v2.toolHooks[0].cb(undefined)).not.toThrow()
    expect(posts[0]).toEqual({ event: 'tool.execute.before', sessionID: 'ses_1' })
    v2.end()
  })

  it('2.x: a subagent child session does not move the node, but its blocking prompts do (under the root id)', async () => {
    const def = await loadPlugin()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    v2.push('session.created', { sessionID: 'ses_c', parentID: 'ses_1' })
    v2.push('session.created', { sessionID: 'ses_g', parentID: 'ses_c' })
    v2.push('session.execution.started', { sessionID: 'ses_c' })
    v2.push('permission.asked', { id: 'per_1', sessionID: 'ses_g' })
    v2.push('form.created', { form: { id: 'frm_1', sessionID: 'ses_c' } })
    v2.push('form.replied', { id: 'frm_1', sessionID: 'ses_c' })
    v2.push('session.execution.succeeded', { sessionID: 'ses_c' })
    await flush()
    v2.toolHooks[0].cb({ tool: 'read', sessionID: 'ses_c' })
    expect(posts).toEqual([
      { event: 'permission.asked', sessionID: 'ses_1' },
      { event: 'question.asked', sessionID: 'ses_1' },
      { event: 'question.replied', sessionID: 'ses_1' }
    ])
    v2.end()
  })

  it('2.x: arms inside the shared background server (`serve --service`) — on 2.x that is the only process that loads plugins', async () => {
    // The regression (measured in the field across OpenCode 2.1.3–2.2.5, Nov 2026): 2.x loads
    // plugins ONLY in serve processes, and the long-lived server a nodeterm machine keeps is the
    // managed `opencode serve --service`. The 1.x file beside this plugin cannot arm there (2.x
    // rejects it at load — no default export), so a v2 that steps aside in `--service` processes
    // leaves no subscriber anywhere and the badge froze. Yielding was a 1.x-era rule (there the
    // v1 file COULD load in the same process); on 2.x setup() must arm and stay armed.
    const def = await loadPlugin()
    const v2 = v2Context()
    const argv = process.argv
    process.argv = ['bun', '/$bunfs/root/opencode', 'serve', '--service']
    try {
      const cleanup = await def.setup(v2.ctx)
      expect(v2.subscribed()).toBe(1)
      expect(v2.toolHooks.map((h) => h.name)).toEqual(['execute.before'])
      expect(g[LATCH]).toBe('v2') // armed as v2 — the latch still arbitrates v1 vs v2 per process
      expect(typeof cleanup).toBe('function')
      expect(v2.signal()?.aborted).toBe(false)
      ;(cleanup as () => void)()
      expect(v2.signal()?.aborted).toBe(true) // the returned cleanup aborts the subscription
    } finally {
      process.argv = argv
    }
    v2.end()
  })

  it('2.x: no NODETERM_NODE_ID (outside nodeterm) → no subscription, no hook — even in a `--service` server', async () => {
    // Removing the --service yield must not overcorrect: the node-id gate (makePoster() → null)
    // keeps the plugin inert outside nodeterm-spawned envs, whatever the process shape is.
    vi.stubEnv('NODETERM_NODE_ID', '')
    const def = await loadPlugin()
    const v2 = v2Context()
    const argv = process.argv
    process.argv = ['bun', '/$bunfs/root/opencode', 'serve', '--service']
    try {
      await def.setup(v2.ctx)
    } finally {
      process.argv = argv
    }
    expect(v2.subscribed()).toBe(0)
    expect(v2.toolHooks).toEqual([])
    expect(g[LATCH]).toBeUndefined()
  })

  it('2.x: posts the full wire format from a `--service` server to a local unix-socket collector', async () => {
    // Ported from the upstream suite's `posts_to_local_collector`. The ONLY endpoint configured is
    // a throwaway unix socket this test creates in its own temp dir (never a real nodeterm one),
    // and the per-node token comes from a token dir this test writes — so the full POST contract
    // (both bearer headers, form encoding, the three body fields) is checked against the real
    // node:http socketPath transport, from inside a `serve --service` process: on 2.x that is the
    // process the plugin runs in.
    const { createServer } = await import('node:http')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-v2-'))
    const tokenDir = path.join(dir, 'tokens')
    fs.mkdirSync(tokenDir)
    const nodeId = 'node-v2-wire'
    // The per-node token file (<dir>/<nodeId>, first line is the bearer) — the same file shape
    // hook-server.ts reads (a lookup by name, never a scan).
    fs.writeFileSync(path.join(tokenDir, nodeId), 'node-token\nignored-second-line\n')
    const hits: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        hits.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: {
            'x-nodeterm-hook-token': String(req.headers['x-nodeterm-hook-token'] ?? ''),
            'x-nodeterm-node-token': String(req.headers['x-nodeterm-node-token'] ?? ''),
            'content-type': String(req.headers['content-type'] ?? '')
          },
          body: Buffer.concat(chunks).toString('utf8')
        })
        res.writeHead(204)
        res.end()
      })
    })
    const sock = path.join(dir, 'hook.sock')
    await new Promise<void>((r) => server.listen(sock, r))
    try {
      vi.stubEnv('NODETERM_NODE_ID', nodeId)
      vi.stubEnv('NODETERM_HOOK_SOCK', sock)
      vi.stubEnv('NODETERM_HOOK_TOKEN', 'hook-token')
      vi.stubEnv('NODETERM_HOOK_VERSION', '2')
      vi.stubEnv('NODETERM_NODE_TOKEN_DIR', tokenDir)
      const def = await loadPlugin()
      const v2 = v2Context()
      const argv = process.argv
      process.argv = ['bun', '/$bunfs/root/opencode', 'serve', '--service']
      try {
        const cleanup = await def.setup(v2.ctx)
        expect(v2.subscribed()).toBe(1) // armed at all (the regression) before anything else
        v2.push('session.created', { sessionID: 'sess-post-1' })
        // The plugin posts from a detached async loop; poll the local collector briefly.
        await vi.waitFor(() => expect(hits.length).toBe(1))
        const hit = hits[0]
        expect(hit.method).toBe('POST')
        expect(hit.url).toBe('/hook/opencode')
        expect(hit.headers['x-nodeterm-hook-token']).toBe('hook-token')
        expect(hit.headers['x-nodeterm-node-token']).toBe('node-token')
        expect(hit.headers['content-type']).toBe('application/x-www-form-urlencoded')
        const params = new URLSearchParams(hit.body)
        expect(params.get('nodeId')).toBe(nodeId)
        expect(params.get('version')).toBe('2')
        expect(JSON.parse(params.get('payload') ?? '{}')).toEqual({
          event: 'session.created',
          sessionID: 'sess-post-1'
        })
        ;(cleanup as () => void)()
      } finally {
        process.argv = argv
        v2.end()
      }
    } finally {
      server.close()
      server.closeAllConnections?.()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('2.x: a context without an event stream (a 1.x compatibility pass) is a no-op', async () => {
    const def = await loadPlugin()
    await def.setup({ options: {}, agent: {}, catalog: {} })
    await def.setup(undefined)
    expect(g[LATCH]).toBeUndefined()
  })

  it('2.x: the cleanup setup returns aborts the subscription', async () => {
    const def = await loadPlugin()
    const v2 = v2Context()
    const cleanup = await def.setup(v2.ctx)
    expect(typeof cleanup).toBe('function')
    expect(v2.signal()?.aborted).toBe(false)
    ;(cleanup as () => void)()
    expect(v2.signal()?.aborted).toBe(true)
    v2.end()
  })

  // ── Latch arbitration (one process, both adapters) ────────────────────────────────────────
  // A process normally runs only ONE generation's loader, but both adapters live in one module
  // now: a 2.x that ever grows a v1 compatibility layer, or repeated arming in one process (one
  // plugin instance per project directory), must not double-post. The first API to arm owns the
  // process — keyed by API, not by call.
  it('server() armed first keeps setup() inert (one process, both adapters)', async () => {
    const def = await loadPlugin()
    const hooks = await def.server()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    expect(v2.subscribed()).toBe(0)
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    expect(posts).toEqual([{ event: 'session.idle', sessionID: 'ses_1' }])
  })

  it('setup() armed first keeps server() empty', async () => {
    const def = await loadPlugin()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    expect(await def.server()).toEqual({})
    v2.end()
  })

  it('the latch is per API, not per call: second instances of the SAME API still arm', async () => {
    const def = await loadPlugin()
    expect(typeof (await def.server()).event).toBe('function')
    expect(typeof (await def.server()).event).toBe('function') // one process, two project dirs
    delete g[LATCH]
    const a = v2Context()
    const b = v2Context()
    await def.setup(a.ctx)
    await def.setup(b.ctx)
    expect(a.subscribed()).toBe(1)
    expect(b.subscribed()).toBe(1)
    a.end()
    b.end()
  })

  it('the generated template carries no `--service` early return', () => {
    // Durable source guard, ported from the local regression suite's `service_early_return_absent`
    // and now pointed at the SINGLE builder: if the early return ever comes back, every 2.x
    // machine's badge dies silently again (see the service-server test above for why). Asserted
    // on the exact expression so that comments ABOUT `serve --service` may still live there.
    expect(buildOpencodePlugin()).not.toContain("argv.includes('--service')")
  })
})
