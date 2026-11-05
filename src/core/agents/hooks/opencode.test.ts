import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_MARKER,
  buildOpencodePlugin,
  buildOpencodeV2Plugin,
  installOpencodeHooks,
  opencodeConfigDir,
  opencodeMajorFrom,
  pluginPath,
  probeOpencodeMajorAt,
  removeOpencodeHooks,
  v2PluginPath
} from './opencode'
import { normalizeOpencode } from '../../../shared/agents/normalize'

// Both generated plugins share one process-wide latch (which plugin API armed first). Every test
// loads fresh module copies into the SAME process, so the latch is reset before each one.
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

/** The version probe as a controlled answer. Every policy test injects one: the DEFAULT probe
 *  (the memoized real `opencodeMajor()`) resolves the login shell and may spawn the machine's
 *  real opencode — which these tests must never do. */
const versionProbe = (major: number | null) => () => Promise.resolve(major)

/** A probe that stays pending until the test lands it, so the synchronous install pass can be
 *  asserted exactly as a machine sees it at boot: the 2.x directory planted, the 1.x file not
 *  yet decided. Same shape as the antigravity probe tests: the promise exists EAGERLY (the
 *  implementation defers calling the probe by a microtask, so a lazily-created one could never
 *  be resolved by the time the test lands its answer). */
function deferredProbe(): {
  probe: () => Promise<number | null>
  resolve: (major: number | null) => void
  reject: (e: Error) => void
} {
  let settle!: (major: number | null) => void
  let fail!: (e: Error) => void
  const pending = new Promise<number | null>((res, rej) => {
    settle = res
    fail = rej
  })
  return { probe: () => pending, resolve: (major) => settle(major), reject: (e) => fail(e) }
}

describe('opencode plugin install', () => {
  it('writes the marker-bearing 1.x plugin once the probe decides 1.x (idempotent)', async () => {
    await installOpencodeHooks(versionProbe(1))
    await installOpencodeHooks(versionProbe(1))
    const body = fs.readFileSync(planted(), 'utf8')
    expect(body.startsWith(PLUGIN_MARKER)).toBe(true)
    expect(body).toContain('NODETERM_NODE_ID')
    expect(body).toContain('/hook/opencode')
  })
  it('never overwrites a user 1.x file without the marker — on either side of the decision', async () => {
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.writeFileSync(planted(), '// my own plugin\n')
    await installOpencodeHooks(versionProbe(1)) // the plant branch must not touch it
    await installOpencodeHooks(versionProbe(2)) // the remove branch must not touch it
    expect(fs.readFileSync(planted(), 'utf8')).toBe('// my own plugin\n')
  })
  it('remove deletes only a marker-bearing 1.x file', async () => {
    await installOpencodeHooks(versionProbe(1))
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
    return mod.NodetermStatus()
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
    return mod.NodetermStatus()
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
    return mod.NodetermStatus()
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
      await installOpencodeHooks(versionProbe(1))
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

// Issue #1136. OpenCode 2.x needs a default export object `{ id, setup }`; OpenCode <= 1.2.10
// calls every export as a function and dies on an object (bisected on real builds). So there are
// TWO plugins: the 1.x file (named export only) and a 2.x DIRECTORY no 1.x glob matches.
const planted2 = () => path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status-v2', 'index.js')

describe('opencode plugin install — the 2.x directory plugin', () => {
  it('plants both plugins, each marker-bearing, at the paths each opencode generation loads', async () => {
    await installOpencodeHooks(versionProbe(1))
    expect(v2PluginPath()).toBe(planted2())
    expect(fs.readFileSync(planted(), 'utf8')).toBe(buildOpencodePlugin())
    expect(fs.readFileSync(planted2(), 'utf8')).toBe(buildOpencodeV2Plugin())
    expect(fs.readFileSync(planted2(), 'utf8').startsWith(PLUGIN_MARKER)).toBe(true)
  })
  it('refreshes a stale managed copy (an older build\'s body) but never a user file', async () => {
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.mkdirSync(path.dirname(planted2()), { recursive: true })
    fs.writeFileSync(planted(), PLUGIN_MARKER + '\n// old v1 body\n')
    fs.writeFileSync(planted2(), PLUGIN_MARKER + '\n// old v2 body\n')
    await installOpencodeHooks(versionProbe(1))
    expect(fs.readFileSync(planted(), 'utf8')).toBe(buildOpencodePlugin())
    expect(fs.readFileSync(planted2(), 'utf8')).toBe(buildOpencodeV2Plugin())
    fs.writeFileSync(planted2(), '// my own v2 plugin\n')
    await installOpencodeHooks(versionProbe(1))
    expect(fs.readFileSync(planted2(), 'utf8')).toBe('// my own v2 plugin\n')
  })
  it('does not rewrite an up-to-date file (opencode 2.x watches plugin files and reloads on change)', async () => {
    const d = deferredProbe()
    const pending = installOpencodeHooks(d.probe)
    const past = Math.floor(Date.now() / 1000) - 60 // whole seconds: mtimeMs is a float
    fs.utimesSync(planted2(), past, past)
    d.resolve(1)
    await pending
    expect(Math.round(fs.statSync(planted2()).mtimeMs / 1000)).toBe(past)
    // and the decided 1.x file too: a second install with the same answer must not rewrite it
    fs.utimesSync(planted(), past, past)
    await installOpencodeHooks(versionProbe(1))
    expect(Math.round(fs.statSync(planted()).mtimeMs / 1000)).toBe(past)
  })
  it('remove deletes both managed plugins and the now-empty directory, but keeps anything else', async () => {
    await installOpencodeHooks(versionProbe(1))
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(false)
    expect(fs.existsSync(path.dirname(planted2()))).toBe(false)
    await installOpencodeHooks(versionProbe(1))
    fs.writeFileSync(path.join(path.dirname(planted2()), 'notes.txt'), 'mine')
    removeOpencodeHooks()
    expect(fs.existsSync(planted2())).toBe(false)
    expect(fs.readFileSync(path.join(path.dirname(planted2()), 'notes.txt'), 'utf8')).toBe('mine')
  })
})

// The version gate (the second half of the 2.x fix). The pair is planted by GENERATION of the
// installed CLI: the 2.x directory always (it is invisible to every 1.x glob), the 1.x FILE
// only where the installed CLI is 1.x or its version is unknown — never planted "for a moment"
// on a known 2.x, which WARNs on the file at every load and reloads on every change.
describe('opencode install — the version-gated 1.x file', () => {
  it('plants the 2.x directory synchronously and holds the 1.x file until the version is known', async () => {
    const d = deferredProbe()
    const pending = installOpencodeHooks(d.probe)
    expect(fs.readFileSync(planted2(), 'utf8').startsWith(PLUGIN_MARKER)).toBe(true) // armed at once
    expect(fs.existsSync(planted())).toBe(false) // NOT even temporarily planted on an unknown box
    d.resolve(1)
    await pending
    expect(fs.existsSync(planted())).toBe(true)
  })

  it('known 2.x never plants the 1.x file, and migrates away the managed copy an older nodeterm left', async () => {
    // The upgrade path: every nodeterm before this gate planted the 1.x file unconditionally.
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.writeFileSync(planted(), PLUGIN_MARKER + '\n// the old unconditional 1.x body\n')
    await installOpencodeHooks(versionProbe(2))
    expect(fs.existsSync(planted())).toBe(false) // marker-managed legacy copy removed
    expect(fs.readFileSync(planted2(), 'utf8').startsWith(PLUGIN_MARKER)).toBe(true) // 2.x armed
  })

  it('known 2.x leaves a user\'s own 1.x file exactly as it was (no marker → not ours to remove)', async () => {
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.writeFileSync(planted(), '// my own plugin\n')
    await installOpencodeHooks(versionProbe(2))
    expect(fs.readFileSync(planted(), 'utf8')).toBe('// my own plugin\n')
  })

  it('known 1.x plants the 1.x file — a 2.x→1.x downgrade is not stranded badge-less', async () => {
    await installOpencodeHooks(versionProbe(2)) // a previous launch decided 2.x: the file is gone
    expect(fs.existsSync(planted())).toBe(false)
    await installOpencodeHooks(versionProbe(1)) // the user downgraded opencode
    expect(fs.readFileSync(planted(), 'utf8')).toBe(buildOpencodePlugin())
  })

  it('unknown version (no CLI found, timeout, unreadable output) plants the 1.x file conservatively', async () => {
    // Conservative = today's behavior: every <=1.x machine keeps its badge even when the probe
    // cannot answer, at the cost of the harmless load WARN on a 2.x machine.
    await installOpencodeHooks(versionProbe(null))
    expect(fs.readFileSync(planted(), 'utf8')).toBe(buildOpencodePlugin())
  })

  it('a probe that rejects is contained and treated as unknown: v1 planted, install never rejects', async () => {
    await installOpencodeHooks(() => Promise.reject(new Error('probe boom')))
    expect(fs.readFileSync(planted(), 'utf8')).toBe(buildOpencodePlugin())
  })

  it('a decision still pending behind a remove/opt-out writes nothing afterwards', async () => {
    const d = deferredProbe()
    const pending = installOpencodeHooks(d.probe) // launch-time install, probe still in flight
    removeOpencodeHooks() // the user declines opencode in Settings (or uninstalls)
    d.resolve(1) // a late "1.x" answer must NOT re-plant what the opt-out deleted
    await pending
    expect(fs.existsSync(planted())).toBe(false)
    expect(fs.existsSync(planted2())).toBe(false)
    expect(fs.existsSync(path.dirname(planted2()))).toBe(false)
  })

  it('a NEW install after the opt-out still plants (the gate cancels only superseded decisions)', async () => {
    const d = deferredProbe()
    const stale = installOpencodeHooks(d.probe)
    removeOpencodeHooks()
    d.resolve(1)
    await stale
    await installOpencodeHooks(versionProbe(1)) // re-enabled: a fresh generation may plant again
    expect(fs.readFileSync(planted(), 'utf8')).toBe(buildOpencodePlugin())
    expect(fs.readFileSync(planted2(), 'utf8')).toBe(buildOpencodeV2Plugin())
  })
})

// The probe that feeds the gate. `opencodeMajorFrom` is the pure decision input;
// `probeOpencodeMajorAt` runs a FAKE CLI from a temp dir (never the machine's real opencode —
// a sh script printing the measured `--version` line), so the spawn/exit-code plumbing is
// exercised without touching any real installation.
describe('opencodeMajorFrom — the version parser', () => {
  it('reads the measured `--version` shapes', () => {
    expect(opencodeMajorFrom('opencode v2.2.5\n')).toBe(2) // MEASURED, 2026-11-05, exit 0
    expect(opencodeMajorFrom('2.0.30')).toBe(2)
    expect(opencodeMajorFrom('1.18.3')).toBe(1)
    expect(opencodeMajorFrom('1.2.10')).toBe(1) // the last call-every-export-as-a-function build
  })
  it('answers null — "unknown", the conservative branch — for anything it cannot read a version out of', () => {
    expect(opencodeMajorFrom('opencode: command not found')).toBeNull()
    expect(opencodeMajorFrom('')).toBeNull()
    expect(opencodeMajorFrom('   ')).toBeNull()
    expect(opencodeMajorFrom(null)).toBeNull()
    expect(opencodeMajorFrom(undefined)).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('probeOpencodeMajorAt — the bounded CLI probe', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-probe-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A fake `opencode` binary: prints the given `--version` line (the real CLI's measured shape). */
  const fakeBin = (line: string, exit = 0): string => {
    const bin = path.join(dir, 'opencode')
    fs.writeFileSync(bin, `#!/bin/sh\necho '${line}'\nexit ${exit}\n`)
    fs.chmodSync(bin, 0o755)
    return bin
  }

  it('answers the major the CLI printed on stdout', async () => {
    expect(await probeOpencodeMajorAt(fakeBin('opencode v2.2.5'))).toBe(2)
    expect(await probeOpencodeMajorAt(fakeBin('opencode 1.18.3'))).toBe(1)
  })
  it('answers null when there is no version to read, or the CLI exits non-zero', async () => {
    expect(await probeOpencodeMajorAt(fakeBin('command not found'))).toBeNull()
    expect(await probeOpencodeMajorAt(fakeBin('opencode v2.2.5', 1))).toBeNull()
  })
  it('answers null when no binary exists at the path', async () => {
    expect(await probeOpencodeMajorAt(path.join(dir, 'missing'))).toBeNull()
  })
})

describe('generated plugins, module shapes (executed)', () => {
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
  type V2Def = { id: string; setup: (ctx: unknown) => Promise<(() => void) | void> }

  async function load(body: string): Promise<Record<string, unknown>> {
    const file = path.join(tmp, `plugin-${Math.random().toString(36).slice(2)}.mjs`)
    fs.writeFileSync(file, body)
    return import(/* @vite-ignore */ `file://${file}`)
  }
  const loadV1 = async (): Promise<{ NodetermStatus: () => Promise<V1Hooks> }> =>
    (await load(buildOpencodePlugin())) as unknown as { NodetermStatus: () => Promise<V1Hooks> }
  const loadV2 = async (): Promise<V2Def> => (await load(buildOpencodeV2Plugin())).default as V2Def

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

  it('1.x file: ONLY the named function export — a default would crash opencode <= 1.2.10', async () => {
    const mod = await load(buildOpencodePlugin())
    // opencode <= 1.2.10 does `for (const [, fn] of Object.entries(mod)) await fn(input)`.
    expect(Object.keys(mod)).toEqual(['NodetermStatus'])
    for (const v of Object.values(mod)) expect(typeof v).toBe('function')
  })

  it('2.x directory plugin: a default OBJECT with an id and a setup function, nothing else exported', async () => {
    const mod = await load(buildOpencodeV2Plugin())
    expect(Object.keys(mod)).toEqual(['default'])
    const def = mod.default as V2Def
    expect(typeof def).toBe('object')
    expect(def.id).toBe('nodeterm-status')
    expect(typeof def.setup).toBe('function')
  })

  it('2.x: translates the event stream to the 1.x wire names normalizeOpencode reads', async () => {
    const def = await loadV2()
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
    const def = await loadV2()
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
    const def = await loadV2()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    expect(v2.toolHooks.map((h) => h.name)).toEqual(['execute.before'])
    expect(() => v2.toolHooks[0].cb({ tool: 'shell', sessionID: 'ses_1', id: 'call_1' })).not.toThrow()
    expect(() => v2.toolHooks[0].cb(undefined)).not.toThrow()
    expect(posts[0]).toEqual({ event: 'tool.execute.before', sessionID: 'ses_1' })
    v2.end()
  })

  it('2.x: a subagent child session does not move the node, but its blocking prompts do (under the root id)', async () => {
    const def = await loadV2()
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
    const def = await loadV2()
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
    const def = await loadV2()
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

  it('2.x: the generated template carries no `--service` early return', () => {
    // Durable source guard, ported from the local regression suite's `service_early_return_absent`:
    // if the early return ever comes back, every 2.x machine's badge dies silently again (see the
    // service-server test above for why). Asserted on the exact expression so that comments ABOUT
    // `serve --service` may still live in the template.
    expect(buildOpencodeV2Plugin()).not.toContain("argv.includes('--service')")
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
      const def = await loadV2()
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
    const def = await loadV2()
    await def.setup({ options: {}, agent: {}, catalog: {} })
    await def.setup(undefined)
    expect(g[LATCH]).toBeUndefined()
  })

  it('both plugins in ONE process: 1.x armed first keeps 2.x inert (no double posts)', async () => {
    const v1 = await loadV1()
    const hooks = await v1.NodetermStatus()
    const def = await loadV2()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    expect(v2.subscribed()).toBe(0)
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    expect(posts).toEqual([{ event: 'session.idle', sessionID: 'ses_1' }])
  })

  it('both plugins in ONE process: 2.x armed first keeps the 1.x hooks empty', async () => {
    const def = await loadV2()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    const v1 = await loadV1()
    expect(await v1.NodetermStatus()).toEqual({})
    v2.end()
  })

  it('the latch is per API, not per call: a second plugin instance of the SAME API still arms', async () => {
    const v1 = await loadV1()
    expect(typeof (await v1.NodetermStatus()).event).toBe('function')
    expect(typeof (await v1.NodetermStatus()).event).toBe('function')
    const def = await loadV2()
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

  it('2.x: the cleanup setup returns aborts the subscription', async () => {
    const def = await loadV2()
    const v2 = v2Context()
    const cleanup = await def.setup(v2.ctx)
    expect(typeof cleanup).toBe('function')
    expect(v2.signal()?.aborted).toBe(false)
    ;(cleanup as () => void)()
    expect(v2.signal()?.aborted).toBe(true)
    v2.end()
  })
})
