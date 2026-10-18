import { evaluatePage, elementBounds, dispatchMouse, drag, extractVirtualTable, type EvaluateParams, type BoundsParams, type MouseParams, type DragParams, type VirtualTableParams } from './advancedBrowser.js'
import type { CdpSession } from './cdpSession.js'
import { focusElement, resolveElementPoint, readViewportSize } from './elementResolver.js'
import { describeFileInput, FileChooserInterceptor, type FileChooserRequest } from './fileChooser.js'
import {
  fieldHoldsText,
  hasRecipient,
  isRecipientField,
  parseEmailList,
  probeFocusedField,
  probeRecipientField,
  type FocusedField,
  type RecipientField,
} from './fieldProbe.js'
import {
  clearFocusedField,
  dispatchNativeClick,
  dispatchNativeKeyPress,
  dispatchNativeScroll,
  dispatchNativeType,
} from './nativeInput.js'
import { capturePageScreenshot, fetchAccessibilityTree } from './pageInspector.js'
import { buildSemanticState } from './stateBuilder.js'
import { settleAfterAction, waitForDomStable, waitForNavigation } from './waitEngine.js'
import {
  moveVirtualCursor,
  parkVirtualCursor,
  pulseVirtualCursorClick,
  pulseVirtualCursorScroll,
  pulseVirtualCursorTyping,
  setAgentOverlayActive,
} from './virtualCursor.js'
import { captureActionSignature, verifyAction, type ActionSignature } from './verificationEngine.js'
import {
  BrowserRuntimeError,
  toRuntimeFailure,
  type ActionAck,
  type ActionVerification,
  type VerificationExpectation,
  type AgentSecuritySnapshot,
  type ClickParams,
  type ElementHandle,
  type FillParams,
  type NavigateParams,
  type NavigationResult,
  type PageStateSnapshot,
  type PressKeyParams,
  type RuntimeCommandName,
  type RuntimeCommandResult,
  type RuntimeParams,
  type RuntimeResult,
  type ScreenshotParams,
  type ScreenshotResult,
  type OverlayParams,
  type ScrollParams,
  type SessionDownload,
  type TargetDescriptor,
  type TypeParams,
  type UploadParams,
  type WaitParams,
} from './runtimeContract.js'

/**
 * Domains the agent needs. `Input` has no enable command — its events are
 * dispatched directly.
 */
const AGENT_CDP_DOMAINS = ['Page', 'DOM', 'Runtime', 'Accessibility'] as const

/** Only ordinary web navigation is permitted; `javascript:`, `file:`, and `data:` are not. */
const ALLOWED_NAVIGATION_SCHEMES = new Set(['http:', 'https:', 'about:'])

const DEFAULT_SCROLL_DELTA = 400

/** What typing into a field achieved, as the field probe saw it. */
type FieldEntry = {
  /** True/false when the probe could read the field; null when it could not tell. */
  landed: boolean | null
  /** What the focused field held instead, when the text did not land. */
  fieldText?: string
  /** Replaces the generic verification reason when the entry succeeded. */
  reason?: string
}

/**
 * One line per recipient-field step in the main-process log, so a field that
 * misbehaves on a real site can be diagnosed from the terminal. Only the
 * field's own raw text and a yes/no for the address are logged, never the
 * surrounding page.
 */
function logRecipientStep(step: string, field: RecipientField | null, address?: string): void {
  console.info('[browser-runtime] recipient field', JSON.stringify({
    step,
    address,
    found: field !== null,
    isInput: field?.isInput,
    fieldText: field?.fieldText.slice(0, 120),
    addressIsChip: field && address ? hasRecipient(field, address) : undefined,
  }))
}

function landedIn(focused: FocusedField, expected: string): FieldEntry {
  if (focused.state === 'none') return { landed: false }
  if (focused.state !== 'editable') return { landed: null }
  return fieldHoldsText(focused.text, expected)
    ? { landed: true }
    : { landed: false, fieldText: focused.text }
}

/**
 * The single gateway through which every agent-driven browser action passes.
 *
 * Design constraints this class exists to enforce:
 *  - No agent action may reach the page except through `invoke()`, so later
 *    phases can gate, verify, and recover from actions in one place.
 *  - The runtime is independent of the LLM: it knows nothing about planners,
 *    goals, or prompts.
 *  - Native input and bounded guest-page evaluation share this gateway.
 *
 * Phases 1–3 implement the lifecycle, the inspection layer, and the action
 * layer. File upload runs only behind the Phase 7 approval workflow.
 */
/**
 * Supplies the deep page capture the agent's security scan consumes. Injected
 * so the runtime stays unaware of who implements the capture, and so the agent
 * path never calls the manual scanner's IPC channel.
 */
export type DeepContentProvider = (targetId: number) => Promise<Record<string, unknown> | null>

/**
 * Opens a native file picker and returns what the user chose. Returning an
 * empty array means they cancelled, which the runtime treats as refusal.
 */
export type FilePickerProvider = () => Promise<string[]>

/** A completed download the runtime may attach. `path` never leaves the main process. */
export type DownloadedFile = { filename: string; sizeBytes: number; path: string }

/**
 * Lists the files this browser downloaded during the current session, newest
 * first, whose file is still on disk.
 */
export type DownloadsProvider = () => DownloadedFile[]

export type BrowserRuntimeOptions = {
  deepContentProvider?: DeepContentProvider
  filePickerProvider?: FilePickerProvider
  downloadsProvider?: DownloadsProvider
}

/** Enough for "the file I just downloaded" without flooding the planner prompt. */
const MAX_PLANNER_DOWNLOADS = 10

const SNAPSHOT_FIELDS: readonly (keyof AgentSecuritySnapshot)[] = [
  'visible_text', 'hidden_text', 'html_comments', 'meta_tags', 'input_values', 'aria_text',
  'iframe_content', 'shadow_dom_content', 'inline_javascript', 'external_javascript', 'css_content',
  'css_generated_content', 'dom_snapshot_content', 'page_title', 'url',
]

export class BrowserRuntime {
  private readonly targets = new Map<number, CdpSession>()
  /** Latest element id → node binding per target, refreshed by extractPageState. */
  private readonly elementHandles = new Map<number, Map<string, ElementHandle>>()
  /** Latest download id → file binding per target, refreshed by extractPageState. */
  private readonly downloadHandles = new Map<number, Map<string, DownloadedFile>>()
  private readonly fileChoosers = new FileChooserInterceptor()
  private readonly deepContentProvider?: DeepContentProvider
  private readonly filePickerProvider?: FilePickerProvider
  private readonly downloadsProvider?: DownloadsProvider
  private actionCounter = 0

  constructor(options: BrowserRuntimeOptions = {}) {
    this.deepContentProvider = options.deepContentProvider
    this.filePickerProvider = options.filePickerProvider
    this.downloadsProvider = options.downloadsProvider
  }

  /**
   * Marks a guest webview as drivable by the agent. Only registered targets
   * can be addressed over IPC, so a compromised renderer cannot point the
   * runtime at arbitrary webContents.
   */
  registerTarget(session: CdpSession): void {
    this.targets.set(session.targetId, session)
    this.fileChoosers.observe(session)
    void session.enableDomains(AGENT_CDP_DOMAINS).catch((error) => {
      console.warn(`[browser-runtime] Domain setup failed for target ${session.targetId}:`, error)
    })
  }

  unregisterTarget(targetId: number): void {
    this.targets.delete(targetId)
    this.elementHandles.delete(targetId)
    this.downloadHandles.delete(targetId)
    this.fileChoosers.forget(targetId)
  }

  /**
   * Called while the agent holds a tab: file choosers the page opens are
   * intercepted instead of showing the OS dialog, which the agent cannot
   * operate (see fileChooser.ts). Resolves quietly for an unknown target.
   */
  async interceptFileChoosers(targetId: number, enabled: boolean): Promise<void> {
    const session = this.targets.get(targetId)
    if (!session?.isAlive()) return
    await this.fileChoosers.hold(session, enabled)
  }

  isRegistered(targetId: number): boolean {
    return this.targets.get(targetId)?.isAlive() ?? false
  }

  listTargets(): number[] {
    return [...this.targets.values()].filter((session) => session.isAlive()).map((session) => session.targetId)
  }

  /**
   * Resolves a planner-visible element id back to its accessibility/DOM node.
   * Returns undefined when no state has been extracted yet or the id is stale.
   */
  resolveElement(targetId: number, elementId: string): ElementHandle | undefined {
    return this.elementHandles.get(targetId)?.get(elementId)
  }

  async invoke<K extends RuntimeCommandName>(
    targetId: number,
    name: K,
    params: RuntimeParams<K>,
  ): Promise<RuntimeResult<RuntimeCommandResult<K>>> {
    try {
      if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        throw new BrowserRuntimeError('INVALID_ARGUMENT', `Command ${name} expects an object of parameters`)
      }

      const session = this.requireSession(targetId)
      const data = await this.dispatch(session, name, params)
      return { ok: true, data: data as RuntimeCommandResult<K> }
    } catch (error) {
      return { ok: false, error: toRuntimeFailure(error) }
    }
  }

  private requireSession(targetId: number): CdpSession {
    const session = this.targets.get(targetId)
    if (!session) {
      throw new BrowserRuntimeError('NO_TARGET', `Target ${targetId} is not registered with the browser runtime`)
    }
    if (!session.isAlive()) {
      this.targets.delete(targetId)
      this.elementHandles.delete(targetId)
      throw new BrowserRuntimeError('TARGET_DETACHED', `Target ${targetId} lost its CDP session`)
    }

    return session
  }

  /**
   * Element ids only survive until the next `extractPageState`. A miss means
   * the page moved on, which Phase 6 recovery answers by rebuilding state.
   */
  private requireHandle(session: CdpSession, elementId: unknown): ElementHandle {
    if (typeof elementId !== 'string' || !elementId) {
      throw new BrowserRuntimeError('INVALID_ARGUMENT', 'An element id is required')
    }

    const handle = this.elementHandles.get(session.targetId)?.get(elementId)
    if (!handle) {
      throw new BrowserRuntimeError(
        'ELEMENT_NOT_FOUND',
        `Element ${elementId} is unknown or stale; extract page state again`,
      )
    }

    return handle
  }

  private dispatch(session: CdpSession, name: RuntimeCommandName, params: object): Promise<unknown> {
    switch (name) {
      case 'evaluate': return evaluatePage(session, params as EvaluateParams)
      case 'elementBounds': return elementBounds(session, params as BoundsParams)
      case 'dispatchMouseEvent': return dispatchMouse(session, params as MouseParams)
      case 'drag': return drag(session, params as DragParams)
      case 'extractVirtualTable': return extractVirtualTable(session, params as VirtualTableParams)
      case 'describeTarget':
        return this.describeTarget(session)
      case 'extractPageState':
        return this.extractPageState(session)
      case 'captureScreenshot':
        return this.captureScreenshot(session, params as ScreenshotParams)
      case 'captureSecuritySnapshot':
        return this.captureSecuritySnapshot(session)
      case 'navigate':
        return this.navigate(session, params as NavigateParams)
      case 'click':
        return this.click(session, params as ClickParams)
      case 'fill':
        return this.fill(session, params as FillParams)
      case 'type':
        return this.type(session, params as TypeParams)
      case 'pressKey':
        return this.pressKey(session, params as PressKeyParams)
      case 'scroll':
        return this.scroll(session, params as ScrollParams)
      case 'upload':
        return this.upload(session, params as UploadParams)
      case 'waitForNavigation':
        return this.waitForNavigation(session, params as WaitParams)
      case 'waitForDomStable':
        return this.waitForDomStable(session, params as WaitParams)
      case 'setAgentOverlay':
        return this.setAgentOverlay(session, params as OverlayParams)
      default:
        return Promise.reject(new BrowserRuntimeError('INVALID_ARGUMENT', `Unknown runtime command: ${String(name)}`))
    }
  }

  private async describeTarget(session: CdpSession): Promise<TargetDescriptor> {
    return {
      targetId: session.targetId,
      url: session.url(),
      title: session.title(),
      attached: session.isAlive(),
    }
  }

  /**
   * Rebuilds the semantic view of the page and re-binds element ids. Element
   * ids are only valid until the next extraction, so this call and the actions
   * that follow it must stay within one planning cycle.
   */
  private async extractPageState(session: CdpSession): Promise<PageStateSnapshot> {
    const nodes = await fetchAccessibilityTree(session)
    const { state, handles } = buildSemanticState({
      targetId: session.targetId,
      url: session.url(),
      title: session.title(),
      nodes,
      capturedAt: Date.now(),
    })

    this.elementHandles.set(session.targetId, new Map(handles.map((handle) => [handle.elementId, handle])))
    const chooser = await this.fileChoosers.pendingRequest(session)
    return {
      ...state,
      downloads: this.bindDownloads(session.targetId),
      fileChooser: chooser ? { multiple: chooser.multiple } : null,
    }
  }

  /**
   * Gives this session's downloads short ids (`d1`, `d2`, …) for the planner,
   * the same way elements get `e1`, `e2`. Like element ids, they are only
   * valid until the next extraction.
   */
  private bindDownloads(targetId: number): SessionDownload[] {
    const files = (this.downloadsProvider?.() ?? []).slice(0, MAX_PLANNER_DOWNLOADS)
    const bound = new Map(files.map((file, index) => [`d${index + 1}`, file]))
    this.downloadHandles.set(targetId, bound)
    return [...bound].map(([id, file]) => ({ id, filename: file.filename, sizeBytes: file.sizeBytes }))
  }

  private requireDownload(session: CdpSession, downloadId: unknown): DownloadedFile {
    if (typeof downloadId !== 'string' || !downloadId) {
      throw new BrowserRuntimeError('INVALID_ARGUMENT', 'A download id is required')
    }

    const file = this.downloadHandles.get(session.targetId)?.get(downloadId)
    // Re-checked against the live list: the file may have been removed from
    // the downloads panel or deleted from disk since the state was read.
    const stillAvailable = file && (this.downloadsProvider?.() ?? []).some((candidate) => candidate.path === file.path)
    if (!file || !stillAvailable) {
      throw new BrowserRuntimeError(
        'ELEMENT_NOT_FOUND',
        `Download ${downloadId} is unknown or no longer available; extract page state again`,
      )
    }

    return file
  }

  private captureScreenshot(session: CdpSession, params: ScreenshotParams): Promise<ScreenshotResult> {
    return capturePageScreenshot(session, params)
  }

  /**
   * Deep content capture for the agent's own security scan.
   *
   * Kept as a runtime command so that everything the agent does to a page —
   * including observing it for threats — flows through the one gateway. The
   * manual "Scan Page" IPC channel is never involved.
   */
  private async captureSecuritySnapshot(session: CdpSession): Promise<AgentSecuritySnapshot> {
    if (!this.deepContentProvider) {
      throw new BrowserRuntimeError('NOT_IMPLEMENTED', 'No deep content provider is configured for the browser runtime')
    }

    const captured = await this.deepContentProvider(session.targetId)
    if (!captured) {
      // An empty capture must never be mistaken for a clean page.
      throw new BrowserRuntimeError('CDP_ERROR', `Deep content capture failed for target ${session.targetId}`)
    }

    const snapshot = {} as AgentSecuritySnapshot
    for (const field of SNAPSHOT_FIELDS) {
      const value = captured[field]
      snapshot[field] = typeof value === 'string' ? value : ''
    }
    if (!snapshot.url) snapshot.url = session.url()
    if (!snapshot.page_title) snapshot.page_title = session.title()

    return snapshot
  }

  private async navigate(session: CdpSession, params: NavigateParams): Promise<NavigationResult> {
    const url = this.validateNavigationUrl(params.url)
    const before = await captureActionSignature(session)

    // Arm the wait before navigating so a fast load cannot land first.
    const navigationSettled = waitForNavigation(session, { timeoutMs: params.timeoutMs })
    await session.send('Page.navigate', { url })
    await navigationSettled

    // Any element id from the previous page is meaningless now.
    this.elementHandles.delete(session.targetId)

    const after = await captureActionSignature(session)
    return {
      ...this.ack(verifyAction(before, after, { expectation: 'url' })),
      url: session.url(),
    }
  }

  private validateNavigationUrl(candidate: unknown): string {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new BrowserRuntimeError('INVALID_ARGUMENT', 'A navigation url is required')
    }

    let parsed: URL
    try {
      parsed = new URL(candidate)
    } catch {
      throw new BrowserRuntimeError('NAVIGATION_BLOCKED', `Not a valid absolute url: ${candidate}`)
    }

    if (!ALLOWED_NAVIGATION_SCHEMES.has(parsed.protocol)) {
      throw new BrowserRuntimeError('NAVIGATION_BLOCKED', `Navigation scheme ${parsed.protocol} is not permitted`)
    }

    return parsed.toString()
  }

  /**
   * Runs an action between a before/after signature so the caller learns
   * whether it actually took effect, not merely that it was dispatched.
   */
  private async withVerification(
    session: CdpSession,
    expectation: VerificationExpectation,
    action: () => Promise<void>,
    options: { backendNodeId?: number; expectedValue?: string } = {},
  ): Promise<ActionAck> {
    const before: ActionSignature = expectation === 'none'
      ? { url: '', structureHash: '', scrollY: 0, targetValue: null, targetChecked: null, targetExpanded: null }
      : await captureActionSignature(session, options.backendNodeId)

    await action()
    // The settled tree is reused as the "after" snapshot rather than fetched
    // again, which removes one full accessibility-tree round trip per action.
    const settledNodes = await settleAfterAction(session)

    if (expectation === 'none') return this.ack()

    const after = await captureActionSignature(session, options.backendNodeId, settledNodes)
    return this.ack(verifyAction(before, after, { expectation, expectedValue: options.expectedValue }))
  }

  private async click(session: CdpSession, params: ClickParams): Promise<ActionAck> {
    const handle = this.requireHandle(session, params.elementId)
    const point = await resolveElementPoint(session, handle)
    await moveVirtualCursor(session, point, handle.name || 'click')

    // A click that hits an overlay dispatches fine but changes nothing, so
    // "something changed" is the weakest honest expectation we can assert.
    return this.withVerification(
      session,
      'change',
      async () => {
        await pulseVirtualCursorClick(session, point)
        await dispatchNativeClick(session, point, { button: params.button, clickCount: params.clickCount })
      },
      { backendNodeId: handle.backendNodeId },
    )
  }

  /**
   * Focuses the field, clears it with a real select-all + delete, then types.
   * The value is never assigned through script; the field probe only reads
   * where focus went and what the field holds, so a fill is judged by whether
   * the text actually landed rather than by "something on the page changed".
   *
   * Recipient fields (mail To/Cc/Bcc, invite guests) hold addresses as chips,
   * and a typed address that is still raw text is not a recipient. Each
   * address is therefore committed with Enter once the suggestion list has
   * caught up with it.
   */
  private async fill(session: CdpSession, params: FillParams): Promise<ActionAck> {
    if (typeof params.value !== 'string') {
      throw new BrowserRuntimeError('INVALID_ARGUMENT', 'fill requires a string value')
    }

    const handle = this.requireHandle(session, params.elementId)
    // Clicking focuses the way a user would, which also opens comboboxes and
    // date pickers that only react to pointer input.
    const point = await resolveElementPoint(session, handle)
    await moveVirtualCursor(session, point, handle.name || 'fill')

    const before = await captureActionSignature(session, handle.backendNodeId)
    const delayMs = params.delayMs ?? 0

    await pulseVirtualCursorClick(session, point)
    await dispatchNativeClick(session, point)
    await this.focusFieldForTyping(session, handle)

    const recipients = isRecipientField(handle) ? parseEmailList(params.value) : null
    let entry: FieldEntry
    if (recipients) {
      // No select-all + Backspace here: in a chip field, Backspace on an empty
      // input reopens or deletes the last chip, which is how a retried fill
      // left the same address in the field twice.
      await pulseVirtualCursorTyping(session, `type "${params.value.slice(0, 40)}"`)
      entry = await this.enterRecipients(session, handle, recipients, delayMs)
    } else {
      await clearFocusedField(session)
      await pulseVirtualCursorTyping(session, `type "${params.value.slice(0, 40)}"`)
      entry = await this.enterText(session, handle, params.value, delayMs)
    }

    const settledNodes = await settleAfterAction(session)
    const after = await captureActionSignature(session, handle.backendNodeId, settledNodes)
    const verification = verifyAction(before, after, {
      expectation: 'value',
      expectedValue: params.value,
      typedLanded: entry.landed,
      fieldText: entry.fieldText,
    })

    return this.ack(verification.verified && entry.reason ? { ...verification, reason: entry.reason } : verification)
  }

  /**
   * Keeps the focus the click produced when it is usable, and only falls back
   * to `DOM.focus` when it is not. Re-focusing unconditionally broke "click to
   * edit" proxies such as Gmail's collapsed "Recipients" row: the click
   * focuses the real input, and focusing the proxy afterwards pulled focus
   * back off it, so every keystroke went nowhere.
   */
  private async focusFieldForTyping(session: CdpSession, handle: ElementHandle): Promise<void> {
    const { focused, targetEditable } = await probeFocusedField(session, handle)
    if (focused.state === 'opaque') return

    if (focused.state === 'editable' || focused.state === 'unverifiable') {
      // A different field took focus. That is right when the target is only a
      // proxy for it, and a mis-aimed click when the target is a field itself.
      if (focused.relatedToTarget || targetEditable !== true) return
    }

    await focusElement(session, handle).catch(() => undefined)
  }

  private async enterText(
    session: CdpSession,
    handle: ElementHandle,
    value: string,
    delayMs: number,
  ): Promise<FieldEntry> {
    await dispatchNativeType(session, value, delayMs)
    const { focused } = await probeFocusedField(session, handle)
    return landedIn(focused, value)
  }

  /**
   * Adds each address to a chip field without disturbing the chips already
   * there. Filling is idempotent: an address that is already a recipient is
   * skipped, so a planner that retries — because a chip never shows up in the
   * accessibility tree as a field value — cannot add it twice.
   */
  private async enterRecipients(
    session: CdpSession,
    handle: ElementHandle,
    addresses: string[],
    delayMs: number,
  ): Promise<FieldEntry> {
    const added: string[] = []
    const alreadyThere: string[] = []
    const unconfirmed: string[] = []
    const uncommitted: string[] = []

    const initial = await probeRecipientField(session, handle)
    if (!initial) return { landed: false }
    logRecipientStep('start', initial)

    // Leftover raw text from an earlier attempt is erased one character at a
    // time from the end, which never reaches the chips before it. A
    // contenteditable keeps its chips inside the text, so it is left alone.
    if (initial.isInput && initial.fieldText.length > 0) {
      await dispatchNativeKeyPress(session, 'End')
      for (let index = 0; index < Math.min(initial.fieldText.length, 500); index += 1) {
        await dispatchNativeKeyPress(session, 'Backspace')
      }
    }

    for (const address of addresses) {
      const current = await probeRecipientField(session, handle)
      if (!current) return { landed: false }
      if (hasRecipient(current, address) && !fieldHoldsText(current.fieldText, address)) {
        alreadyThere.push(address)
        continue
      }

      // An address that did not commit is still raw text in the field, so the
      // next one needs a separator to stay a separate address.
      await dispatchNativeType(session, uncommitted.length > 0 ? `, ${address}` : address, delayMs)

      const typed = await probeRecipientField(session, handle)
      logRecipientStep('typed', typed, address)
      if (!typed || !fieldHoldsText(typed.fieldText, address)) {
        return { landed: false, fieldText: typed?.fieldText }
      }

      // Let the suggestion list catch up with the whole address, so Enter
      // commits this address rather than a suggestion for a prefix of it.
      await settleAfterAction(session)
      await dispatchNativeKeyPress(session, 'Enter')
      let outcome = await this.recipientOutcome(session, handle, address, 'enter')

      // Mail clients also split recipients on a comma; it is the fallback for
      // a field whose Enter handling ignored the key.
      if (outcome === 'pending') {
        await dispatchNativeKeyPress(session, ',')
        outcome = await this.recipientOutcome(session, handle, address, 'comma')
        if (outcome === 'pending') {
          // The comma did nothing either: take it back out of the raw text.
          await dispatchNativeKeyPress(session, 'Backspace')
        }
      }

      if (outcome === 'added') added.push(address)
      else if (outcome === 'unconfirmed') unconfirmed.push(address)
      else uncommitted.push(address)
    }

    const reasons: string[] = []
    if (added.length > 0) {
      reasons.push(`Added ${added.join(', ')} as ${added.length === 1 ? 'a recipient' : 'recipients'}`)
    }
    if (alreadyThere.length > 0) {
      reasons.push(
        `${alreadyThere.join(', ')} ${alreadyThere.length === 1 ? 'was' : 'were'} already a recipient, so nothing was typed again`,
      )
    }
    if (unconfirmed.length > 0) {
      reasons.push(
        `the field accepted ${unconfirmed.join(', ')}, but no recipient with that exact address is shown — ` +
          'a suggested contact may have been picked instead; check the To field before sending',
      )
    }
    if (uncommitted.length > 0) {
      reasons.push(
        `typed ${uncommitted.join(', ')} into the recipient field, but it did not become a recipient chip — ` +
          'select the matching suggestion before sending',
      )
    }

    const reason = reasons.join('; ')
    return { landed: true, reason: reason.charAt(0).toUpperCase() + reason.slice(1) }
  }

  /**
   * `added`: the input let go of the address and a chip carries it.
   * `unconfirmed`: the input let go of it, but no chip shows that address.
   * `pending`: the address is still raw text in the input.
   */
  private async recipientOutcome(
    session: CdpSession,
    handle: ElementHandle,
    address: string,
    step: string,
  ): Promise<'added' | 'unconfirmed' | 'pending'> {
    const field = await probeRecipientField(session, handle)
    logRecipientStep(step, field, address)
    if (!field) return 'unconfirmed'
    if (fieldHoldsText(field.fieldText, address)) return 'pending'
    return hasRecipient(field, address) ? 'added' : 'unconfirmed'
  }

  private async type(session: CdpSession, params: TypeParams): Promise<ActionAck> {
    if (typeof params.text !== 'string') {
      throw new BrowserRuntimeError('INVALID_ARGUMENT', 'type requires a string text')
    }

    return this.withVerification(
      session,
      'change',
      async () => {
        await pulseVirtualCursorTyping(session, `type "${params.text.slice(0, 40)}"`)
        await dispatchNativeType(session, params.text, params.delayMs ?? 0)
      },
    )
  }

  private async pressKey(session: CdpSession, params: PressKeyParams): Promise<ActionAck> {
    if (typeof params.key !== 'string' || !params.key) {
      throw new BrowserRuntimeError('INVALID_ARGUMENT', 'pressKey requires a key name')
    }

    return this.withVerification(
      session,
      'change',
      async () => {
        await pulseVirtualCursorTyping(session, params.key)
        await dispatchNativeKeyPress(session, params.key, params.modifiers ?? 0)
      },
    )
  }

  /**
   * Scrolls with a real wheel event. Without an element the wheel is aimed at
   * the viewport centre, which scrolls whatever container is under it — the
   * same behaviour a user gets.
   */
  private async scroll(session: CdpSession, params: ScrollParams): Promise<ActionAck> {
    const point = params.elementId
      ? await resolveElementPoint(session, this.requireHandle(session, params.elementId))
      : await this.viewportCentre(session)

    const deltaX = typeof params.deltaX === 'number' ? params.deltaX : 0
    const deltaY = typeof params.deltaY === 'number' ? params.deltaY : (params.deltaX ? 0 : DEFAULT_SCROLL_DELTA)

    // Scrolling usually leaves the accessibility tree untouched, so the
    // viewport offset is the signal that matters here.
    return this.withVerification(session, 'scroll', async () => {
      await pulseVirtualCursorScroll(session, point, deltaY)
      await dispatchNativeScroll(session, point, deltaX, deltaY)
    })
  }

  /**
   * Switches the cosmetic agent overlay on or off. Kept as a runtime command so
   * the renderer can light the page up for the duration of a task without ever
   * touching the guest webview itself, and so failures degrade to "no overlay"
   * rather than a failed task.
   */
  private async setAgentOverlay(session: CdpSession, params: OverlayParams): Promise<ActionAck> {
    const active = params.active === true
    await setAgentOverlayActive(session, active)

    // Park the cursor mid-viewport so the first real move glides from
    // somewhere sensible instead of materialising on the target.
    if (active) {
      const centre = await this.viewportCentre(session).catch(() => null)
      if (centre) await parkVirtualCursor(session, centre)
    }

    return this.ack()
  }

  private async viewportCentre(session: CdpSession) {
    const { width, height } = await readViewportSize(session)
    if (width === 0 || height === 0) {
      throw new BrowserRuntimeError('CDP_ERROR', 'Could not read the viewport size')
    }

    return { x: width / 2, y: height / 2 }
  }

  /**
   * Attaches files to a file input.
   *
   * `DOM.setFileInputFiles` can hand any readable file on the machine to a
   * remote site, which is exactly what an indirect prompt injection would aim
   * for. The defence is structural: the planner never supplies a path. It
   * either names one of this session's downloads by id, or the user picks the
   * files in a native OS dialog. Either way the approval policy has already
   * asked the user before this runs, so the worst a fully compromised planner
   * can do is propose attaching a file this browser itself just downloaded.
   */
  private async upload(session: CdpSession, params: UploadParams): Promise<ActionAck> {
    const handle = this.requireHandle(session, params.elementId)
    // Resolved before anything is clicked, so a bad id has no side effects.
    const download = params.downloadId === undefined ? undefined : this.requireDownload(session, params.downloadId)
    const pickFiles = this.filePickerProvider
    if (!download && !pickFiles) {
      throw new BrowserRuntimeError('APPROVAL_REQUIRED', 'No file picker is available to confirm this upload')
    }

    const chooser = await this.resolveFileChooser(session, handle)
    const files = download ? [download.path] : await pickFiles!()
    if (!files.length) {
      throw new BrowserRuntimeError('APPROVAL_REQUIRED', 'The upload was cancelled; no files were selected')
    }
    const attached = chooser.multiple ? files : files.slice(0, 1)

    await session.send('DOM.setFileInputFiles', { files: attached, backendNodeId: chooser.backendNodeId })
    this.fileChoosers.settle(session.targetId)
    await settleAfterAction(session)

    return this.ack({
      verified: true,
      urlChanged: false,
      structureChanged: false,
      scrollChanged: false,
      valueChanged: true,
      checkedChanged: false,
      expectation: 'none',
      reason: download
        ? `Attached "${download.filename}" from this session's downloads`
        : `Attached ${attached.length} file(s) chosen by the user`,
    })
  }

  /**
   * Finds the file input that will receive the files: the target itself, the
   * chooser an earlier click already opened, or the one the target opens when
   * clicked now — sites usually hide the input behind an "Attach" button.
   */
  private async resolveFileChooser(session: CdpSession, handle: ElementHandle): Promise<FileChooserRequest> {
    if (typeof handle.backendNodeId === 'number') {
      const input = await describeFileInput(session, handle.backendNodeId)
      if (input) return input
    }

    const pending = await this.fileChoosers.pendingRequest(session)
    if (pending) return pending

    const point = await resolveElementPoint(session, handle)
    await moveVirtualCursor(session, point, handle.name || 'upload')
    const opened = await this.fileChoosers.capture(session, async () => {
      await pulseVirtualCursorClick(session, point)
      await dispatchNativeClick(session, point)
    })
    if (!opened) {
      throw new BrowserRuntimeError(
        'ELEMENT_NOT_INTERACTABLE',
        `Element ${handle.elementId} ("${handle.name}") did not open a file chooser; target the file input or its attach button`,
      )
    }

    return opened
  }

  private async waitForNavigation(session: CdpSession, params: WaitParams): Promise<ActionAck> {
    await waitForNavigation(session, params)
    this.elementHandles.delete(session.targetId)
    return this.ack()
  }

  private async waitForDomStable(session: CdpSession, params: WaitParams): Promise<ActionAck> {
    await waitForDomStable(session, params)
    return this.ack()
  }

  private ack(verification?: ActionVerification): ActionAck {
    this.actionCounter += 1
    return { actionId: `act_${this.actionCounter}`, completedAt: Date.now(), verification }
  }
}
