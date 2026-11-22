import type { AXNode, AXProperty } from './pageInspector.js'
import type {
  CheckedState,
  ElementHandle,
  PagePopup,
  PageStateSnapshot,
  SemanticDialog,
  SemanticElement,
  ValidationIssue,
} from './runtimeContract.js'

/**
 * Converts a raw accessibility tree into the compact semantic state the
 * planner reasons over.
 *
 * This module is deliberately pure: no CDP session, no I/O, no clock beyond
 * the caller-supplied timestamp. That keeps the AXTree → state mapping — the
 * part most likely to need tuning as real sites are exercised — independently
 * inspectable and testable.
 */

/** Roles the agent can act on. Everything else is decorative for our purposes. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
])

const DIALOG_ROLES = new Set(['dialog', 'alertdialog'])
const ALERT_ROLES = new Set(['alert', 'alertdialog', 'status'])
const CONTAINER_ROLES = new Set([
  'form',
  'region',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'main',
  'table',
  'section',
  'group',
  'fieldset',
  'search',
  'tabpanel',
])

/**
 * Containers that sit over or beside the page rather than being part of it.
 * A close button inside one of these closes a popup or a panel.
 */
const OVERLAY_ROLES = new Set(['dialog', 'alertdialog', 'tooltip', 'complementary'])

/** Labels that close or decline something and commit nothing. Listed for the planner. */
export const CLOSE_LABEL =
  /^(got it|ok,? got it|dismiss|close|close (this |the )?(panel|sidebar|side panel|dialog|tips?|banner|popup|window|message|menu)|hide|no,? thanks|not now|maybe later|skip|skip (tour|for now|intro)|×|✕|✖|x)$/i

/**
 * The subset so harmless the loop clicks them unasked: they only acknowledge
 * a tip or decline an offer. "Close" and "Skip" are deliberately absent — the
 * agent may itself have opened the dialog they would close.
 */
export const AUTO_CLOSE_LABEL = /^(got it|ok,? got it|dismiss|no,? thanks|not now|maybe later|skip tour|skip for now|close tips?)$/i

const MAX_POPUPS = 8
const MAX_DEPTH = 60

const MAX_ELEMENTS = 500
const MAX_DIALOGS = 25
const MAX_VALIDATION_ISSUES = 50
const MAX_NAME_LENGTH = 300
const MAX_VALUE_LENGTH = 500
const MAX_NEARBY_TEXT_LENGTH = 400
/** Below this many characters a text run is punctuation/noise, not a label. */
const MIN_NEARBY_TEXT_LENGTH = 6

export type StateBuilderInput = {
  targetId: number
  url: string
  title: string
  nodes: AXNode[]
  capturedAt: number
}

export type BuiltState = {
  state: PageStateSnapshot
  handles: ElementHandle[]
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function normalizeText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  return clip(value.replace(/\s+/g, ' ').trim(), limit)
}

function propertyMap(node: AXNode): Map<string, unknown> {
  const properties: AXProperty[] = Array.isArray(node.properties) ? node.properties : []
  const map = new Map<string, unknown>()
  for (const property of properties) {
    if (typeof property?.name === 'string') {
      map.set(property.name, property.value?.value)
    }
  }

  return map
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true'
}

function asCheckedState(value: unknown): CheckedState | undefined {
  return value === 'true' || value === 'false' || value === 'mixed' ? value : undefined
}

/** An `invalid` of anything other than "false" means the field is in error. */
function invalidReason(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === 'false' || !value) return undefined
  return value
}

/**
 * A node earns a planner-visible id if the agent might act on it, if it is a
 * dialog the agent must notice, or if it is an alert carrying a validation
 * message. Everything else is dropped.
 */
function isExposed(role: string, properties: Map<string, unknown>): boolean {
  if (INTERACTIVE_ROLES.has(role) || DIALOG_ROLES.has(role) || ALERT_ROLES.has(role)) return true
  // Editable non-textbox containers (contenteditable divs) still accept input.
  return asBoolean(properties.get('editable'))
}

export function buildSemanticState(input: StateBuilderInput): BuiltState {
  const elements: SemanticElement[] = []
  const dialogs: SemanticDialog[] = []
  const validationErrors: ValidationIssue[] = []
  const selectedElementIds: string[] = []
  const handles: ElementHandle[] = []

  let focusedElementId: string | null = null
  let idCounter = 0
  let truncated = false
  /**
   * The most recent substantial block of plain text seen while walking the
   * tree in document order — replaced, not accumulated, on every new text
   * node. A quiz question, a form field's label, an instruction: none of it
   * is reliably tied to its control by ARIA on an arbitrary page, so reading
   * order is the only association available. Every control encountered
   * before the next text block inherits this same value, exactly like a
   * sighted reader would associate the last thing they read with what
   * follows it.
   */
  let recentText = ''
  let currentContainer = ''

  // Parent links survive in the full tree (ignored nodes included), so each
  // close button can be tied to the popup or panel it belongs to.
  const byNodeId = new Map<string, AXNode>()
  for (const node of input.nodes) if (typeof node.nodeId === 'string') byNodeId.set(node.nodeId, node)
  const overlayOf = (node: AXNode): AXNode | null => {
    let current = typeof node.parentId === 'string' ? byNodeId.get(node.parentId) : undefined
    for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
      const role = typeof current.role?.value === 'string' ? current.role.value : ''
      if (OVERLAY_ROLES.has(role) && !asBoolean(propertyMap(current).get('hidden'))) return current
      current = typeof current.parentId === 'string' ? byNodeId.get(current.parentId) : undefined
    }
    return null
  }
  const popups = new Map<string, PagePopup>()

  for (const node of input.nodes) {
    if (node.ignored === true || typeof node.nodeId !== 'string') continue

    const role = typeof node.role?.value === 'string' ? node.role.value : ''
    if (!role) continue

    const properties = propertyMap(node)
    if (asBoolean(properties.get('hidden'))) continue

    if (CONTAINER_ROLES.has(role)) {
      const containerName = normalizeText(node.name?.value || properties.get('name') || '', MAX_NAME_LENGTH)
      currentContainer = containerName ? `${role}: ${containerName}` : role
    }

    if (role === 'StaticText') {
      const text = normalizeText(node.name?.value, MAX_NEARBY_TEXT_LENGTH)
      if (text.length >= MIN_NEARBY_TEXT_LENGTH) recentText = text
      continue
    }

    if (!isExposed(role, properties)) continue

    const isInteractive = INTERACTIVE_ROLES.has(role) || asBoolean(properties.get('editable'))
    const isDialog = DIALOG_ROLES.has(role)
    const isAlert = ALERT_ROLES.has(role)
    const invalid = invalidReason(properties.get('invalid'))

    if (isInteractive && elements.length >= MAX_ELEMENTS) {
      truncated = true
      continue
    }

    let name = normalizeText(node.name?.value, MAX_NAME_LENGTH)
    const description = normalizeText(node.description?.value, MAX_NAME_LENGTH)
    const value = normalizeText(node.value?.value, MAX_VALUE_LENGTH)
    const placeholder = normalizeText(properties.get('placeholder'), MAX_NAME_LENGTH)
    const title = normalizeText(properties.get('title'), MAX_NAME_LENGTH)
    const url = normalizeText(properties.get('url'), MAX_NAME_LENGTH)

    // For interactive controls with no explicit accessible name, synthesize smart fallbacks
    // so icon buttons (e.g. submit arrows ">", search icons, filter buttons) and unnamed inputs
    // are fully addressable by the planner.
    if (isInteractive && !name) {
      if (placeholder) {
        name = placeholder
      } else if (title) {
        name = title
      } else if (role === 'button') {
        name = recentText ? `Apply/Action near ${recentText}` : 'Action / Submit button'
      } else if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || asBoolean(properties.get('editable'))) {
        name = recentText ? `Input for ${recentText}` : 'Input field'
      } else if (role === 'link' && url) {
        name = `Link to ${url}`
      }
    }

    // Only skip genuinely non-actionable elements (e.g. empty non-button anchor without href or text)
    if (isInteractive && !name && !value && !description && !invalid && !url && role !== 'button') continue

    idCounter += 1
    const elementId = `e${idCounter}`
    handles.push({
      elementId,
      axNodeId: node.nodeId,
      backendNodeId: typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : undefined,
      role,
      name,
    })

    const focused = asBoolean(properties.get('focused'))
    if (focused && !focusedElementId) focusedElementId = elementId

    if (isInteractive) {
      const selected = asBoolean(properties.get('selected'))
      if (selected) selectedElementIds.push(elementId)

      const element: SemanticElement = { id: elementId, role, name }
      if (currentContainer) element.container = currentContainer
      const inputType = typeof properties.get('type') === 'string'
        ? String(properties.get('type'))
        : (role === 'textbox' || role === 'searchbox' ? role : undefined)
      if (inputType) element.inputType = inputType
      const nameAttr = typeof properties.get('name') === 'string' ? String(properties.get('name')) : undefined
      if (nameAttr && nameAttr !== name) element.nameAttr = nameAttr

      if (value) element.value = value
      if (placeholder) element.placeholder = placeholder
      if (description && description !== name) element.description = description
      if (recentText && recentText !== name && recentText !== description && recentText !== placeholder) {
        element.nearbyText = recentText
      }
      if (url) element.url = url
      if (asBoolean(properties.get('disabled'))) element.disabled = true
      if (asBoolean(properties.get('required'))) element.required = true
      if (focused) element.focused = true
      if (properties.has('expanded')) element.expanded = asBoolean(properties.get('expanded'))
      if (selected) element.selected = true
      const checked = asCheckedState(properties.get('checked'))
      if (checked) element.checked = checked
      if (invalid) element.invalid = invalid

      elements.push(element)

      if ((role === 'button' || role === 'link') && !element.disabled && CLOSE_LABEL.test(name)) {
        const auto = AUTO_CLOSE_LABEL.test(name)
        const overlay = overlayOf(node)
        // A bare "Close" outside any popup or panel could close anything; only
        // the unmistakable acknowledgements are listed without a container.
        if (overlay || auto) {
          const key = overlay?.nodeId ?? `loose:${element.container ?? ''}:${recentText}`
          const popup = popups.get(key) ?? {
            role: overlay ? String(overlay.role?.value ?? 'dialog') : 'tip',
            name: normalizeText(overlay?.name?.value, MAX_NAME_LENGTH) || element.container || recentText.slice(0, 80) || '',
            closeButtons: [],
          }
          popup.closeButtons.push({ id: elementId, name, auto })
          if (popups.size < MAX_POPUPS || popups.has(key)) popups.set(key, popup)
        }
      }
    }

    if (isDialog && dialogs.length < MAX_DIALOGS) {
      dialogs.push({ id: elementId, role, name, modal: asBoolean(properties.get('modal')) })
    }

    if (validationErrors.length < MAX_VALIDATION_ISSUES) {
      // A field flagged invalid, or a live alert region, both surface here so
      // the planner can react to a rejected form without re-reading the page.
      const message = invalid ? description || name || `Field is invalid (${invalid})` : name || description
      if (invalid || (isAlert && message)) {
        validationErrors.push({ elementId, role, message })
      }
    }
  }

  const state: PageStateSnapshot = {
    targetId: input.targetId,
    url: input.url,
    title: normalizeText(input.title, MAX_NAME_LENGTH),
    capturedAt: input.capturedAt,
    elements,
    focusedElementId,
    dialogs,
    validationErrors,
    selectedElementIds,
    truncated,
  }
  if (popups.size > 0) state.popups = [...popups.values()]

  return { state, handles }
}
