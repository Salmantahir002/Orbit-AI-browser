import type { CdpParams, CdpSession } from './cdpSession.js'
import { waitForCdpEvent } from './waitEngine.js'

/**
 * The `<input type="file">` a page wants files for. `multiple` mirrors the
 * input's own attribute, so a single-file field is never handed two files.
 */
export type FileChooserRequest = { backendNodeId: number; multiple: boolean }

/** How long a click on an "Attach" control may take to open its chooser. */
const CHOOSER_OPEN_TIMEOUT_MS = 5_000

function toRequest(params: CdpParams): FileChooserRequest | null {
  // `backendNodeId` is absent for pickers with no input behind them
  // (window.showOpenFilePicker), which DOM.setFileInputFiles cannot fill.
  if (typeof params.backendNodeId !== 'number') return null
  return { backendNodeId: params.backendNodeId, multiple: params.mode === 'selectMultiple' }
}

async function setInterception(session: CdpSession, enabled: boolean): Promise<void> {
  await session.send('Page.setInterceptFileChooserDialog', { enabled })
}

/**
 * Returns the chooser request for a node when it is a file input, else null.
 * A node that no longer exists is reported as null rather than thrown.
 */
export async function describeFileInput(session: CdpSession, backendNodeId: number): Promise<FileChooserRequest | null> {
  const described = await session.send('DOM.describeNode', { backendNodeId }).catch(() => null)
  const node = described?.node as { nodeName?: string; attributes?: string[] } | undefined
  if (node?.nodeName !== 'INPUT') return null

  const attributes = node.attributes ?? []
  const attribute = (name: string) => {
    const index = attributes.findIndex((value, position) => position % 2 === 0 && value.toLowerCase() === name)
    return index === -1 ? undefined : attributes[index + 1]
  }
  if (attribute('type')?.toLowerCase() !== 'file') return null

  return { backendNodeId, multiple: attribute('multiple') !== undefined }
}

/**
 * Keeps the OS file dialog out of agent-driven tabs.
 *
 * Sites rarely expose their file input. They hide it and call `input.click()`
 * from an "Attach" button, and Chromium answers with the native OS dialog.
 * That dialog lives outside the page, so CDP input cannot operate it and the
 * agent stalls (Gmail's paperclip is the usual case). With
 * `Page.setInterceptFileChooserDialog` the dialog is never shown; Chromium
 * reports which input asked for files instead, and the runtime fills that
 * input with `DOM.setFileInputFiles`.
 *
 * Interception is on only while the agent holds a tab, plus the moment an
 * `upload` clicks its own trigger. Outside a task the user's own uploads use
 * the normal OS dialog.
 */
export class FileChooserInterceptor {
  private readonly held = new Set<number>()
  private readonly pending = new Map<number, FileChooserRequest>()

  /** Records every chooser the page opens while interception is on. Call once per session. */
  observe(session: CdpSession): void {
    session.on((method, params) => {
      if (method !== 'Page.fileChooserOpened') return
      const request = toRequest(params)
      if (request) this.pending.set(session.targetId, request)
    })
  }

  /** Starts or stops intercepting for the length of an agent task. */
  async hold(session: CdpSession, held: boolean): Promise<void> {
    if (held) {
      this.held.add(session.targetId)
    } else {
      this.held.delete(session.targetId)
      this.pending.delete(session.targetId)
    }
    await setInterception(session, held)
  }

  /**
   * The chooser the page is still waiting on, if its input still exists. An
   * agent `click` on an "Attach" button leaves one of these behind.
   */
  async pendingRequest(session: CdpSession): Promise<FileChooserRequest | null> {
    const request = this.pending.get(session.targetId)
    if (!request) return null

    // Re-read the node: a page that re-rendered its composer has replaced it.
    const live = await describeFileInput(session, request.backendNodeId)
    if (!live) {
      this.pending.delete(session.targetId)
      return null
    }
    return request
  }

  /** The page has been given its files; the request is answered. */
  settle(targetId: number): void {
    this.pending.delete(targetId)
  }

  forget(targetId: number): void {
    this.held.delete(targetId)
    this.pending.delete(targetId)
  }

  /**
   * Runs `trigger` (a click on an "Attach" control) and returns the chooser it
   * opened, or null when it opened none. Interception is switched on for the
   * click even outside a held task, and restored afterwards.
   */
  async capture(session: CdpSession, trigger: () => Promise<void>): Promise<FileChooserRequest | null> {
    const temporary = !this.held.has(session.targetId)
    // Always (re-)enabled: a debugger re-attach silently drops it.
    await setInterception(session, true)
    this.pending.delete(session.targetId)

    try {
      // Armed before the click, since the chooser opens during it.
      const opened = waitForCdpEvent(
        session,
        (method) => method === 'Page.fileChooserOpened',
        { timeoutMs: CHOOSER_OPEN_TIMEOUT_MS },
        'a file chooser to open',
      ).then(() => true, () => false)

      await trigger()
      return (await opened) ? this.pending.get(session.targetId) ?? null : null
    } finally {
      if (temporary) await setInterception(session, false).catch(() => undefined)
    }
  }
}
