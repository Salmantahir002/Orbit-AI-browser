import type { CdpParams, CdpSession } from './cdpSession.js'
import { fetchAccessibilityTree, type AXNode } from './pageInspector.js'
import { fingerprintNodes } from './verificationEngine.js'
import { BrowserRuntimeError } from './runtimeContract.js'

/**
 * Dynamic waits driven by real browser signals.
 *
 * Fixed sleeps are never used: each wait subscribes to the CDP event that
 * actually indicates readiness, and a timeout exists only so a wedged page
 * cannot hang the agent.
 */

export const DEFAULT_WAIT_TIMEOUT_MS = 10_000
export const DEFAULT_QUIET_PERIOD_MS = 250
const AX_POLL_INTERVAL_MS = 150
const AX_STABLE_SAMPLES = 2

export type WaitOptions = { timeoutMs?: number; quietPeriodMs?: number }

function timeoutMs(options: WaitOptions): number {
  const value = options.timeoutMs
  return typeof value === 'number' && value > 0 ? Math.min(value, 60_000) : DEFAULT_WAIT_TIMEOUT_MS
}

function quietPeriodMs(options: WaitOptions): number {
  const value = options.quietPeriodMs
  return typeof value === 'number' && value >= 0 ? Math.min(value, 10_000) : DEFAULT_QUIET_PERIOD_MS
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Resolves when `predicate` accepts a protocol event, rejects on timeout.
 * The subscription is always torn down, including on the timeout path.
 */
export function waitForCdpEvent(
  session: CdpSession,
  predicate: (method: string, params: CdpParams) => boolean,
  options: WaitOptions,
  description: string,
): Promise<void> {
  const limit = timeoutMs(options)

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: BrowserRuntimeError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      if (error) reject(error)
      else resolve()
    }

    const unsubscribe = session.on((method, params) => {
      let matched: boolean
      try {
        matched = predicate(method, params)
      } catch {
        matched = false
      }
      if (matched) finish()
    })

    const timer = setTimeout(
      () => finish(new BrowserRuntimeError('TIMEOUT', `Timed out after ${limit}ms waiting for ${description}`)),
      limit,
    )
  })
}

/**
 * Waits for the page's load lifecycle to complete. Lifecycle events must be
 * switched on explicitly, which is idempotent per session.
 */
export async function waitForNavigation(session: CdpSession, options: WaitOptions = {}): Promise<void> {
  await session.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => undefined)

  await waitForCdpEvent(
    session,
    (method, params) => {
      if (method === 'Page.loadEventFired') return true
      return method === 'Page.lifecycleEvent' && params.name === 'load'
    },
    options,
    'navigation to finish loading',
  )
}

/**
 * Waits until no network request has started or finished for a quiet period.
 * The Network domain is already enabled on the shared session, so these events
 * arrive without extra setup.
 */
export function waitForNetworkIdle(session: CdpSession, options: WaitOptions = {}): Promise<void> {
  const limit = timeoutMs(options)
  const quiet = quietPeriodMs(options)

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: BrowserRuntimeError) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(quietTimer)
      unsubscribe()
      if (error) reject(error)
      else resolve()
    }

    let quietTimer = setTimeout(() => finish(), quiet)
    const unsubscribe = session.on((method) => {
      if (!method.startsWith('Network.')) return
      // Any network activity restarts the quiet window.
      clearTimeout(quietTimer)
      quietTimer = setTimeout(() => finish(), quiet)
    })

    const deadline = setTimeout(
      () => finish(new BrowserRuntimeError('TIMEOUT', `Timed out after ${limit}ms waiting for network idle`)),
      limit,
    )
  })
}

/**
 * Waits until the accessibility tree stops changing.
 *
 * Polling the AXTree rather than watching DOM mutation events is deliberate:
 * CDP only reports DOM mutations for nodes already pushed to the client, so
 * mutation events are an unreliable completeness signal, whereas the AXTree is
 * always a full picture and is the exact input the State Builder consumes.
 */
export async function waitForDomStable(session: CdpSession, options: WaitOptions = {}): Promise<AXNode[]> {
  const limit = timeoutMs(options)
  const deadline = Date.now() + limit

  let nodes = await fetchAccessibilityTree(session)
  let previous = fingerprintNodes(nodes)
  let stableSamples = 0

  while (Date.now() < deadline) {
    await sleep(AX_POLL_INTERVAL_MS)
    nodes = await fetchAccessibilityTree(session)
    const current = fingerprintNodes(nodes)

    if (current === previous) {
      stableSamples += 1
      // The settled tree is returned so the verification engine can reuse it
      // instead of fetching the same data again a moment later.
      if (stableSamples >= AX_STABLE_SAMPLES) return nodes
    } else {
      stableSamples = 0
      previous = current
    }
  }

  throw new BrowserRuntimeError('TIMEOUT', `Timed out after ${limit}ms waiting for the page to stabilise`)
}

/**
 * Settles the page after an action: give navigation a chance, then wait for
 * the structure to stop moving. Neither signal is required — an action that
 * changes nothing is legitimate — so timeouts resolve rather than throw.
 */
export async function settleAfterAction(session: CdpSession, options: WaitOptions = {}): Promise<AXNode[] | null> {
  const quiet = quietPeriodMs(options)
  await waitForNetworkIdle(session, { timeoutMs: 3_000, quietPeriodMs: quiet }).catch(() => undefined)
  return waitForDomStable(session, { timeoutMs: 3_000, quietPeriodMs: quiet }).catch(() => null)
}
