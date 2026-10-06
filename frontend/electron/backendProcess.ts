import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Owns the lifecycle of the local Node/Fastify backend for the packaged app and
 * for the e2e harness (both launch `dist-electron/main.js` directly, with no
 * `concurrently` wrapper to start a backend for them).
 *
 * In `npm run dev` the `concurrently` script already runs `npm run backend`, so
 * this module deliberately no-ops when PROMPT_DEFENSE_DEV=true to avoid two
 * backends fighting over port 8000.
 *
 * The backend is spawned with Electron's own bundled Node runtime via
 * ELECTRON_RUN_AS_NODE, so the installed application never needs a system
 * Node.js. Startup is best-effort: the renderer already degrades gracefully when
 * the backend is unreachable, so a failed spawn or health check is logged, not
 * fatal.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const BACKEND_PORT = 8000
const HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/api/v1/health`
const HEALTH_TIMEOUT_MS = 15_000
const HEALTH_POLL_INTERVAL_MS = 500

let child: ChildProcess | null = null
let stopping = false

/** Resolves the compiled backend entrypoint for dev-unpackaged vs installed layouts. */
function resolveBackendEntry(): string {
  if (app.isPackaged) {
    // electron-builder copies backend-node/dist -> resources/backend/dist (see electron-builder.yml).
    return path.join(process.resourcesPath, 'backend', 'dist', 'server.js')
  }
  // __dirname === frontend/dist-electron ; backend lives at repo/backend-node.
  return path.join(__dirname, '..', '..', 'backend-node', 'dist', 'server.js')
}

async function waitForHealth(): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), HEALTH_POLL_INTERVAL_MS)
      const response = await fetch(HEALTH_URL, { signal: controller.signal })
      clearTimeout(timeout)
      if (response.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS))
  }
  return false
}

/** Starts the backend (packaged / e2e only) and waits, best-effort, for it to answer /health. */
export async function startBackend(): Promise<void> {
  if (process.env.PROMPT_DEFENSE_DEV === 'true') {
    console.log('[backend] dev mode — backend managed by the concurrently script, not spawning')
    return
  }
  if (child) return

  const entry = resolveBackendEntry()
  console.log(`[backend] starting ${entry}`)

  child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      APP_ENV: 'production',
      PORT: String(BACKEND_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout?.on('data', (buf: Buffer) => process.stdout.write(`[backend] ${buf}`))
  child.stderr?.on('data', (buf: Buffer) => process.stderr.write(`[backend] ${buf}`))

  // Without a listener a failed spawn (e.g. the entry file is missing) is an unhandled 'error'
  // event, which takes the whole main process down instead of degrading to "backend not reachable".
  child.on('error', (error) => {
    console.warn('[backend] failed to start:', error)
    child = null
  })

  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.warn(`[backend] exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
    }
    child = null
  })

  const healthy = await waitForHealth()
  console.log(healthy ? '[backend] healthy' : '[backend] did not become healthy in time — continuing anyway')
}

/** Stops the backend on app shutdown. Safe to call more than once. */
export function stopBackend(): void {
  stopping = true
  if (child && !child.killed) {
    console.log('[backend] stopping')
    child.kill()
  }
  child = null
}
