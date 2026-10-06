import type {
  ClickParams,
  PageStateSnapshot,
  ScrollParams,
  WaitParams,
  RuntimeCommandName,
  RuntimeCommandResult,
  RuntimeParams,
  RuntimeResult,
  ScreenshotResult,
  TargetDescriptor,
} from '../types/browserRuntimeTypes'

/**
 * Renderer-side facade over the main-process Browser Runtime.
 *
 * The agent never touches a webview, `executeJavaScript`, or the DOM directly.
 * Every browser action it takes is a command sent through here, executed over
 * CDP in the main process. This is the seam that later phases hook: the
 * security circuit breaker (Phase 5) and the verification engine (Phase 6)
 * wrap `invoke` rather than individual call sites.
 */

function unavailable(message: string): RuntimeResult<never> {
  return { ok: false, error: { code: 'RUNTIME_UNAVAILABLE', message } }
}

export function isBrowserRuntimeAvailable(): boolean {
  return typeof window.electronAPI?.runtimeInvoke === 'function'
}

export async function invokeRuntime<K extends RuntimeCommandName>(
  targetId: number,
  name: K,
  params: RuntimeParams<K>,
): Promise<RuntimeResult<RuntimeCommandResult<K>>> {
  const runtimeInvoke = window.electronAPI?.runtimeInvoke
  if (!runtimeInvoke) {
    return unavailable('Browser runtime is only available inside the Electron shell')
  }
  if (!Number.isInteger(targetId)) {
    return { ok: false, error: { code: 'NO_TARGET', message: `Invalid target id: ${String(targetId)}` } }
  }

  try {
    const result = await runtimeInvoke({ targetId, name, params })
    return result as RuntimeResult<RuntimeCommandResult<K>>
  } catch (error) {
    return {
      ok: false,
      error: { code: 'CDP_ERROR', message: error instanceof Error ? error.message : String(error) },
    }
  }
}

/**
 * Confirms the runtime holds a live CDP session for a webview and reports what
 * it currently shows. Phase 1's only executable command; useful as a health
 * probe before an agent task starts.
 */
export function describeTarget(targetId: number): Promise<RuntimeResult<TargetDescriptor>> {
  return invokeRuntime(targetId, 'describeTarget', {})
}

/**
 * Rebuilds the semantic page state from the accessibility tree. Element ids in
 * the result are only valid until the next extraction on the same target.
 */
export function extractPageState(targetId: number): Promise<RuntimeResult<PageStateSnapshot>> {
  return invokeRuntime(targetId, 'extractPageState', {})
}

/** Captures a PNG of the page. Feeds the Phase 8 multimodal planner. */
export function captureScreenshot(targetId: number, fullPage = false): Promise<RuntimeResult<ScreenshotResult>> {
  return invokeRuntime(targetId, 'captureScreenshot', { fullPage })
}

/**
 * Browser actions. Each dispatches native CDP input against an element id from
 * the most recent `extractPageState` on the same target, then waits for the
 * page to settle before resolving.
 */

export function navigate(targetId: number, url: string, timeoutMs?: number) {
  return invokeRuntime(targetId, 'navigate', { url, timeoutMs })
}

export function click(targetId: number, elementId: string, options: Omit<ClickParams, 'elementId'> = {}) {
  return invokeRuntime(targetId, 'click', { elementId, ...options })
}

export function fill(targetId: number, elementId: string, value: string, delayMs?: number) {
  return invokeRuntime(targetId, 'fill', { elementId, value, delayMs })
}

export function type(targetId: number, text: string, delayMs?: number) {
  return invokeRuntime(targetId, 'type', { text, delayMs })
}

export function pressKey(targetId: number, key: string, modifiers?: number) {
  return invokeRuntime(targetId, 'pressKey', { key, modifiers })
}

export function scroll(targetId: number, params: ScrollParams = {}) {
  return invokeRuntime(targetId, 'scroll', params)
}

export function waitForNavigation(targetId: number, params: WaitParams = {}) {
  return invokeRuntime(targetId, 'waitForNavigation', params)
}

export function waitForDomStable(targetId: number, params: WaitParams = {}) {
  return invokeRuntime(targetId, 'waitForDomStable', params)
}

/**
 * Turns the visual agent overlay — the virtual cursor and the blue breathing
 * glow — on or off for the duration of a task. Cosmetic: callers should ignore
 * the result, since a page that refuses the overlay is still fully drivable.
 */
export function setAgentOverlay(targetId: number, active: boolean) {
  return invokeRuntime(targetId, 'setAgentOverlay', { active })
}

/**
 * Locks a tab against the user's own mouse and keyboard while the agent drives
 * it, or releases it. The agent's own input is unaffected. Resolves false
 * (never throws) outside Electron or for an unknown tab.
 */
export async function setAgentInputLock(targetId: number, locked: boolean): Promise<boolean> {
  try {
    return (await window.electronAPI?.browser.setAgentLock(targetId, locked)) ?? false
  } catch {
    return false
  }
}
