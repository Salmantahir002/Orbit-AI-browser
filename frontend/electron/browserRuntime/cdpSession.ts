import type { WebContents } from 'electron'
import { BrowserRuntimeError } from './runtimeContract.js'

export type CdpParams = Record<string, unknown>
export type CdpEventListener = (method: string, params: CdpParams) => void

/**
 * A single Chrome DevTools Protocol session bound to one guest webview.
 *
 * Electron allows exactly one `debugger.attach()` per webContents, so the
 * session is the sole owner of that attachment and fans protocol events out to
 * every consumer. Both the manual page scanner and the agent Browser Runtime
 * subscribe here rather than attaching independently.
 *
 * No debugging port is opened: the session rides Electron's existing
 * webContents debugging channel.
 */
export class CdpSession {
  readonly targetId: number

  private readonly contents: WebContents
  private readonly listeners = new Set<CdpEventListener>()
  private readonly enabledDomains = new Set<string>()
  private detached = false

  private constructor(contents: WebContents) {
    this.contents = contents
    this.targetId = contents.id
  }

  static attach(contents: WebContents): CdpSession | null {
    try {
      if (!contents.debugger.isAttached()) {
        contents.debugger.attach('1.3')
      }
    } catch (error) {
      console.warn(`[cdp] Could not attach to target ${contents.id}:`, error)
      return null
    }

    const session = new CdpSession(contents)
    contents.debugger.on('message', (_event, method, params) => {
      session.emit(method, (params ?? {}) as CdpParams)
    })
    contents.debugger.on('detach', (_event, reason) => {
      // "target closed" is an ordinary tab close, not something to warn about.
      if (reason !== 'target closed') console.warn(`[cdp] Detached from target ${contents.id}: ${reason}`)
      if (!contents.isDestroyed()) {
        setTimeout(() => {
          void session.ensureAttached().catch(() => undefined)
        }, 100)
      } else {
        session.detached = true
      }
    })
    contents.once('destroyed', () => {
      session.detached = true
      session.listeners.clear()
    })

    return session
  }

  isAlive(): boolean {
    return !this.contents.isDestroyed() && (!this.detached || this.contents.debugger.isAttached())
  }

  /**
   * Ensures the debugger is attached, re-attaching and restoring domains if detached.
   */
  async ensureAttached(): Promise<boolean> {
    if (this.contents.isDestroyed()) {
      this.detached = true
      return false
    }

    if (!this.contents.debugger.isAttached()) {
      try {
        this.contents.debugger.attach('1.3')
        this.detached = false
        const domainsToRestore = [...this.enabledDomains]
        this.enabledDomains.clear()
        if (domainsToRestore.length > 0) {
          await this.enableDomains(domainsToRestore)
        }
      } catch (error) {
        console.warn(`[cdp] Failed to auto-reattach to target ${this.contents.id}:`, error)
        return false
      }
    }

    this.detached = false
    return true
  }

  url(): string {
    return this.contents.isDestroyed() ? '' : this.contents.getURL()
  }

  title(): string {
    return this.contents.isDestroyed() ? '' : this.contents.getTitle()
  }

  async send(method: string, params?: CdpParams, timeoutMs = 15_000): Promise<CdpParams> {
    const attached = await this.ensureAttached()
    if (!attached || this.contents.isDestroyed()) {
      throw new BrowserRuntimeError('TARGET_DETACHED', `CDP session for target ${this.targetId} is no longer attached`)
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const commandPromise = this.contents.debugger.sendCommand(method, params)
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new BrowserRuntimeError('TIMEOUT', `CDP command ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      })

      const result = await Promise.race([commandPromise, timeoutPromise])
      return (result ?? {}) as CdpParams
    } catch (error) {
      if (error instanceof BrowserRuntimeError) throw error
      throw new BrowserRuntimeError('CDP_ERROR', `${method} failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Enables each domain at most once per session so that two consumers asking
   * for the same domain does not produce duplicate protocol traffic. A domain
   * the target does not support is logged and skipped rather than failing the
   * whole set.
   */
  async enableDomains(domains: readonly string[], params: Record<string, CdpParams> = {}): Promise<void> {
    const pending = domains.filter((domain) => !this.enabledDomains.has(domain))

    await Promise.all(pending.map(async (domain) => {
      try {
        await this.send(`${domain}.enable`, params[domain])
        this.enabledDomains.add(domain)
      } catch (error) {
        // A tab closed while its domains were still being enabled has nothing left to enable.
        if (this.contents.isDestroyed() || (error instanceof Error && /target closed/i.test(error.message))) return
        console.warn(`[cdp] ${domain}.enable failed on target ${this.targetId}:`, error)
      }
    }))
  }

  /** Subscribes to protocol events. Returns an unsubscribe function. */
  on(listener: CdpEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(method: string, params: CdpParams) {
    for (const listener of this.listeners) {
      try {
        listener(method, params)
      } catch (error) {
        console.warn(`[cdp] Listener threw for ${method}:`, error)
      }
    }
  }
}

/** Tracks one CdpSession per guest webview for the lifetime of that webview. */
export class CdpSessionRegistry {
  private readonly sessions = new Map<number, CdpSession>()

  attach(contents: WebContents): CdpSession | null {
    const existing = this.sessions.get(contents.id)
    if (existing?.isAlive()) return existing

    const session = CdpSession.attach(contents)
    if (!session) return null

    this.sessions.set(contents.id, session)
    contents.once('destroyed', () => this.sessions.delete(contents.id))
    return session
  }

  get(targetId: number): CdpSession | undefined {
    const session = this.sessions.get(targetId)
    return session?.isAlive() ? session : undefined
  }
}
