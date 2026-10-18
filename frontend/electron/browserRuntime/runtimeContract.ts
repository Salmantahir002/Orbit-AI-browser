/**
 * Shared contract between the renderer-side agent client and the main-process
 * Browser Runtime. Every browser action the agent performs is expressed as one
 * of the commands below and travels over a single IPC channel, so later phases
 * (security circuit breaker, verification, recovery) have exactly one choke
 * point to guard.
 */

export const RUNTIME_INVOKE_CHANNEL = 'agent:runtime:invoke'

export type BrowserRuntimeErrorCode =
  | 'RUNTIME_UNAVAILABLE'
  | 'NO_TARGET'
  | 'TARGET_DETACHED'
  | 'INVALID_ARGUMENT'
  | 'CDP_ERROR'
  | 'TIMEOUT'
  | 'NOT_IMPLEMENTED'
  /** The element id is unknown or stale — rebuild state before retrying. */
  | 'ELEMENT_NOT_FOUND'
  /** The element exists but has no usable hit target (no layout, offscreen, zero area). */
  | 'ELEMENT_NOT_INTERACTABLE'
  /** Navigation target rejected by the runtime's scheme allowlist. */
  | 'NAVIGATION_BLOCKED'
  /** Action needs explicit human approval, wired up in Phase 7. */
  | 'APPROVAL_REQUIRED'

export class BrowserRuntimeError extends Error {
  readonly code: BrowserRuntimeErrorCode

  constructor(code: BrowserRuntimeErrorCode, message: string) {
    super(message)
    this.name = 'BrowserRuntimeError'
    this.code = code
  }
}

export type RuntimeFailure = { code: BrowserRuntimeErrorCode; message: string }

/** Errors never cross IPC as Error instances, so results are an envelope. */
export type RuntimeResult<T> = { ok: true; data: T } | { ok: false; error: RuntimeFailure }

export type TargetDescriptor = {
  targetId: number
  url: string
  title: string
  attached: boolean
}

/** What a given action implies should have changed about the page. */
export type VerificationExpectation = 'url' | 'value' | 'scroll' | 'change' | 'none'

/**
 * Evidence that an action took effect. The runtime reports; the agent loop's
 * Recovery Engine decides what to do about `verified: false`.
 */
export type ActionVerification = {
  verified: boolean
  urlChanged: boolean
  structureChanged: boolean
  scrollChanged: boolean
  valueChanged: boolean
  /** Checked/unchecked/mixed state of the target flipped — the signal a checkbox or radio click needs. */
  checkedChanged: boolean
  expectation: VerificationExpectation
  reason: string
}

export type ActionAck = {
  /** Runtime-local monotonic id. */
  actionId: string
  completedAt: number
  verification?: ActionVerification
}

export type NavigationResult = ActionAck & { url: string }

export type ScreenshotResult = {
  format: 'png'
  dataBase64: string
  capturedAt: number
}

export type CheckedState = 'true' | 'false' | 'mixed'

/**
 * One actionable thing on the page, addressed by a short runtime-assigned id
 * (`e1`, `e2`, …). The planner only ever refers to elements by this id; it
 * never sees selectors, DOM nodes, or accessibility node ids.
 */
export type SemanticElement = {
  id: string
  role: string
  name: string
  value?: string
  description?: string
  url?: string
  disabled?: boolean
  required?: boolean
  focused?: boolean
  expanded?: boolean
  selected?: boolean
  checked?: CheckedState
  invalid?: string
  /**
   * The nearest preceding block of plain page text, in document order — a
   * question, a label, a hint. Most form controls (this one included, maybe)
   * have no ARIA association to the text that explains them; proximity in
   * reading order is often the only signal there is.
   */
  nearbyText?: string
  placeholder?: string
  /** Structural container or form context enclosing this element (e.g. form: "checkout", nav, table). */
  container?: string
  /** HTML input type or variant (e.g. text, password, email, search, number). */
  inputType?: string
  /** HTML name attribute when present on the element. */
  nameAttr?: string
}

export type SemanticDialog = {
  id: string
  role: string
  name: string
  modal: boolean
}

export type ValidationIssue = {
  elementId: string
  role: string
  message: string
}

/**
 * The compact, planner-facing view of a page. The raw accessibility tree is
 * never exposed beyond the State Builder.
 */
export type PageStateSnapshot = {
  targetId: number
  url: string
  title: string
  capturedAt: number
  elements: SemanticElement[]
  focusedElementId: string | null
  dialogs: SemanticDialog[]
  validationErrors: ValidationIssue[]
  /** Ids of elements the page currently reports as selected (options, tabs, rows). */
  selectedElementIds: string[]
  /** True when the element list hit its cap and was cut short. */
  truncated: boolean
  /**
   * Completed downloads from this browsing session, newest first, which
   * `upload` may attach by id. Supplied by the runtime, not the State Builder.
   */
  downloads?: SessionDownload[]
  /** Set while the page waits for files, e.g. after its "Attach" button was clicked. */
  fileChooser?: { multiple: boolean } | null
}

/**
 * A file this browser downloaded earlier in the session, as the planner sees
 * it: an id (`d1`, `d2`, …) that is only valid until the next
 * `extractPageState`, a name and a size. Never its path.
 */
export type SessionDownload = { id: string; filename: string; sizeBytes: number }

/**
 * Runtime-internal binding from a planner-visible element id back to the
 * accessibility and DOM node it came from. Never crosses IPC — Phase 3 uses it
 * to resolve coordinates for native input events.
 */
export type ElementHandle = {
  elementId: string
  axNodeId: string
  backendNodeId?: number
  role: string
  name: string
}

/**
 * Deep content capture used solely by the agent's security scan. Every field
 * is a separate content channel so the backend can report *where* an injection
 * was planted — hidden text carries far stronger evidence of hostility than
 * the same words in a visible paragraph.
 */
export type AgentSecuritySnapshot = {
  visible_text: string
  hidden_text: string
  html_comments: string
  meta_tags: string
  input_values: string
  aria_text: string
  iframe_content: string
  shadow_dom_content: string
  inline_javascript: string
  external_javascript: string
  css_content: string
  css_generated_content: string
  dom_snapshot_content: string
  page_title: string
  url: string
}

export type NavigateParams = { url: string; timeoutMs?: number }
export type ClickParams = { elementId: string; button?: 'left' | 'right' | 'middle'; clickCount?: number }
export type FillParams = { elementId: string; value: string; delayMs?: number }
export type TypeParams = { text: string; delayMs?: number }
export type PressKeyParams = { key: string; modifiers?: number }
export type ScrollParams = { deltaX?: number; deltaY?: number; elementId?: string }
/**
 * Note there is no `filePaths`: the planner never names a path. Either it
 * names one of this session's downloads by id (`downloadId`), or the user
 * picks the files in a native OS dialog. A hostile page that fully controls
 * the planner can therefore reach nothing on disk except files the browser
 * itself downloaded this session, and the approval policy shows the user
 * that file's name before anything is attached.
 *
 * `elementId` is the file input itself or the control that opens it (an
 * "Attach" button driving a hidden input).
 */
export type UploadParams = { elementId: string; downloadId?: string }
export type WaitParams = { timeoutMs?: number; quietPeriodMs?: number }
export type ScreenshotParams = { fullPage?: boolean }
/**
 * Toggles the cosmetic agent overlay (virtual cursor + breathing glow). Purely
 * presentational: it grants no page access the runtime does not already have,
 * and no action depends on it succeeding.
 */
export type OverlayParams = { active: boolean }
export type EmptyParams = Record<string, never>

export type EvaluateParams = { expression: string; timeoutMs?: number }
export type BoundsParams = { selector: string }
export type MouseParams = {
  type: 'mousePressed' | 'mouseMoved' | 'mouseReleased' | 'mouseWheel'
  x: number; y: number; button?: 'none' | 'left' | 'right' | 'middle'
  buttons?: number; clickCount?: number; deltaX?: number; deltaY?: number; modifiers?: number
}
export type DragParams = { startX: number; startY: number; endX: number; endY: number; steps?: number }
export type VirtualTableParams = {
  rowSelector: string; scrollSelector: string; columns: string
  keyAttribute: string; indexAttribute: string; startIndex?: number; count?: number
}
export type BrowserObservation = { value: unknown }

export type RuntimeCommandMap = {
  evaluate: { params: EvaluateParams; result: BrowserObservation }
  elementBounds: { params: BoundsParams; result: BrowserObservation }
  dispatchMouseEvent: { params: MouseParams; result: BrowserObservation }
  drag: { params: DragParams; result: BrowserObservation }
  extractVirtualTable: { params: VirtualTableParams; result: BrowserObservation }
  describeTarget: { params: EmptyParams; result: TargetDescriptor }
  navigate: { params: NavigateParams; result: NavigationResult }
  click: { params: ClickParams; result: ActionAck }
  fill: { params: FillParams; result: ActionAck }
  type: { params: TypeParams; result: ActionAck }
  pressKey: { params: PressKeyParams; result: ActionAck }
  scroll: { params: ScrollParams; result: ActionAck }
  upload: { params: UploadParams; result: ActionAck }
  waitForNavigation: { params: WaitParams; result: ActionAck }
  waitForDomStable: { params: WaitParams; result: ActionAck }
  captureScreenshot: { params: ScreenshotParams; result: ScreenshotResult }
  extractPageState: { params: EmptyParams; result: PageStateSnapshot }
  captureSecuritySnapshot: { params: EmptyParams; result: AgentSecuritySnapshot }
  setAgentOverlay: { params: OverlayParams; result: ActionAck }
}

export type RuntimeCommandName = keyof RuntimeCommandMap
export type RuntimeParams<K extends RuntimeCommandName> = RuntimeCommandMap[K]['params']
export type RuntimeCommandResult<K extends RuntimeCommandName> = RuntimeCommandMap[K]['result']

export const RUNTIME_COMMAND_NAMES = [
  'evaluate', 'elementBounds', 'dispatchMouseEvent', 'drag', 'extractVirtualTable',
  'describeTarget',
  'navigate',
  'click',
  'fill',
  'type',
  'pressKey',
  'scroll',
  'upload',
  'waitForNavigation',
  'waitForDomStable',
  'captureScreenshot',
  'extractPageState',
  'captureSecuritySnapshot',
  'setAgentOverlay',
] as const satisfies readonly RuntimeCommandName[]

export type RuntimeRequest = {
  targetId: number
  name: RuntimeCommandName
  params: Record<string, unknown>
}

function isCommandName(value: unknown): value is RuntimeCommandName {
  return typeof value === 'string' && (RUNTIME_COMMAND_NAMES as readonly string[]).includes(value)
}

/**
 * The renderer is untrusted for IPC purposes: it may only ask for a known
 * command against an integer target id. Whether that target is one the agent
 * is allowed to drive is decided by the runtime's own registry.
 */
export function parseRuntimeRequest(payload: unknown): RuntimeRequest | null {
  if (!payload || typeof payload !== 'object') return null
  const candidate = payload as Record<string, unknown>
  if (!Number.isInteger(candidate.targetId)) return null
  if (!isCommandName(candidate.name)) return null
  const params = candidate.params
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) return null

  return {
    targetId: candidate.targetId as number,
    name: candidate.name,
    params: (params as Record<string, unknown>) ?? {},
  }
}

export function toRuntimeFailure(error: unknown): RuntimeFailure {
  if (error instanceof BrowserRuntimeError) {
    return { code: error.code, message: error.message }
  }

  return { code: 'CDP_ERROR', message: error instanceof Error ? error.message : String(error) }
}
