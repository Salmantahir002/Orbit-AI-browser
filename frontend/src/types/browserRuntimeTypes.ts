/**
 * Renderer-side mirror of `electron/browserRuntime/runtimeContract.ts`.
 *
 * The two TypeScript projects (`tsconfig.app.json` covers `src` only) cannot
 * import across the process boundary, so these type declarations are kept in
 * sync by hand. Change one, change the other.
 */

export type BrowserRuntimeErrorCode =
  | 'RUNTIME_UNAVAILABLE'
  | 'NO_TARGET'
  | 'TARGET_DETACHED'
  | 'INVALID_ARGUMENT'
  | 'CDP_ERROR'
  | 'TIMEOUT'
  | 'NOT_IMPLEMENTED'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'NAVIGATION_BLOCKED'
  | 'APPROVAL_REQUIRED'

export type RuntimeFailure = { code: BrowserRuntimeErrorCode; message: string }

export type RuntimeResult<T> = { ok: true; data: T } | { ok: false; error: RuntimeFailure }

export type TargetDescriptor = {
  targetId: number
  url: string
  title: string
  attached: boolean
}

export type VerificationExpectation = 'url' | 'value' | 'scroll' | 'change' | 'none'

/** Evidence that an action actually took effect. */
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
  /** The nearest preceding block of plain page text, in document order. */
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

/** Compact, planner-facing view of a page. The raw AXTree never reaches here. */
export type PageStateSnapshot = {
  targetId: number
  url: string
  title: string
  capturedAt: number
  elements: SemanticElement[]
  focusedElementId: string | null
  dialogs: SemanticDialog[]
  validationErrors: ValidationIssue[]
  selectedElementIds: string[]
  truncated: boolean
  /** Completed downloads from this session that `upload` may attach by id. */
  downloads?: SessionDownload[]
  /** Set while the page waits for files, e.g. after its "Attach" button was clicked. */
  fileChooser?: { multiple: boolean } | null
}

/** A file downloaded earlier in this session, addressed by an id valid until the next state extraction. */
export type SessionDownload = { id: string; filename: string; sizeBytes: number }

/** Deep content capture consumed only by the agent's security scan. */
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
 * Note there is no `filePaths`: the planner never names a path. It names one
 * of this session's downloads by id, or the user picks the files in a native
 * OS dialog. `elementId` is the file input or the control that opens it.
 */
export type UploadParams = { elementId: string; downloadId?: string }
export type WaitParams = { timeoutMs?: number; quietPeriodMs?: number }
export type ScreenshotParams = { fullPage?: boolean }
/** Toggles the cosmetic agent overlay (virtual cursor + breathing glow). */
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
