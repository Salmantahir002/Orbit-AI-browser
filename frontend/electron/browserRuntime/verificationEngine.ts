import type { CdpSession } from './cdpSession.js'
import { fetchAccessibilityTree, type AXNode } from './pageInspector.js'
import type { ActionVerification, VerificationExpectation } from './runtimeContract.js'

/**
 * Verification Engine.
 *
 * An action that was dispatched is not an action that worked. A click can land
 * on an overlay, a keystroke can go to a field that never took focus, a
 * navigation can be cancelled. This module takes a cheap signature of the page
 * before and after an action and reports whether the world actually changed in
 * the way that action implies.
 *
 * It reports evidence only. What to *do* about a failed verification — retry,
 * re-find, wait, replan — is the agent loop's Recovery Engine, so that policy
 * stays out of the mechanism.
 */

export type ActionSignature = {
  url: string
  /** Structural fingerprint of the accessibility tree. */
  structureHash: string
  scrollY: number
  /** Current value of the targeted element, when the action had one. */
  targetValue: string | null
  /**
   * Current checked/unchecked/mixed state of the targeted element, when it has
   * one. A checkbox or radio click often changes nothing else observable — no
   * new text, no structural change, no `value` — so without this a page with
   * no other reaction to a selection (e.g. results only revealed by a later
   * "submit" button) would report every checkbox click as a no-op.
   */
  targetChecked: string | null
  /** Current expanded state of an accordion, menu, or combobox. */
  targetExpanded: boolean | null
}

/**
 * Node count plus every role/name/state tuple. Shared with the wait engine so
 * "the page settled" and "the page changed" are judged by the same measure.
 */
export function fingerprintNodes(nodes: AXNode[]): string {
  const parts: string[] = [String(nodes.length)]
  for (const node of nodes) {
    if (node.ignored === true) continue
    const role = typeof node.role?.value === 'string' ? node.role.value : ''
    const name = typeof node.name?.value === 'string' ? node.name.value : ''
    const properties = Array.isArray(node.properties) ? node.properties : []
    const checked = properties.find((p) => p?.name === 'checked')?.value?.value ?? ''
    const expanded = properties.find((p) => p?.name === 'expanded')?.value?.value ?? ''
    const invalid = properties.find((p) => p?.name === 'invalid')?.value?.value ?? ''
    parts.push(`${role}:${name}:${checked}:${expanded}:${invalid}`)
  }

  return parts.join(';')
}

function findNodeValue(nodes: AXNode[], backendNodeId: number): string | null {
  for (const node of nodes) {
    if (node.backendDOMNodeId === backendNodeId) {
      return typeof node.value?.value === 'string' ? node.value.value : ''
    }
  }

  return null
}

/**
 * `checked` lives in the AX node's `properties` array, not on `value` — the
 * same place the State Builder reads it from for the page state shown to the
 * planner.
 */
function findNodeChecked(nodes: AXNode[], backendNodeId: number): string | null {
  for (const node of nodes) {
    if (node.backendDOMNodeId === backendNodeId) {
      const properties = Array.isArray(node.properties) ? node.properties : []
      const checked = properties.find((property) => property?.name === 'checked')
      return typeof checked?.value?.value === 'string' ? checked.value.value : null
    }
  }

  return null
}

function findNodeExpanded(nodes: AXNode[], backendNodeId: number): boolean | null {
  for (const node of nodes) {
    if (node.backendDOMNodeId === backendNodeId) {
      const properties = Array.isArray(node.properties) ? node.properties : []
      const expanded = properties.find((property) => property?.name === 'expanded')
      if (typeof expanded?.value?.value === 'boolean') return expanded.value.value
      if (expanded?.value?.value === 'true') return true
      if (expanded?.value?.value === 'false') return false
      return null
    }
  }

  return null
}

async function readScrollY(session: CdpSession): Promise<number> {
  const metrics = await session.send('Page.getLayoutMetrics').catch((): Record<string, unknown> => ({}))
  const viewport = (metrics.cssVisualViewport ?? metrics.visualViewport) as Record<string, unknown> | undefined
  return typeof viewport?.pageY === 'number' ? viewport.pageY : 0
}

/**
 * @param prefetchedNodes Reuses an accessibility tree the caller already has —
 *   the wait engine returns the tree it settled on, and fetching it a second
 *   time immediately afterwards is the single most expensive redundant call in
 *   an action.
 */
export async function captureActionSignature(
  session: CdpSession,
  backendNodeId?: number,
  prefetchedNodes?: AXNode[] | null,
): Promise<ActionSignature> {
  const [nodes, scrollY] = await Promise.all([
    prefetchedNodes ?? fetchAccessibilityTree(session).catch((): AXNode[] => []),
    readScrollY(session),
  ])

  return {
    url: session.url(),
    structureHash: fingerprintNodes(nodes),
    scrollY,
    targetValue: typeof backendNodeId === 'number' ? findNodeValue(nodes, backendNodeId) : null,
    targetChecked: typeof backendNodeId === 'number' ? findNodeChecked(nodes, backendNodeId) : null,
    targetExpanded: typeof backendNodeId === 'number' ? findNodeExpanded(nodes, backendNodeId) : null,
  }
}

export type VerifyOptions = {
  expectation: VerificationExpectation
  /** For fill/type: the text that should now be present in the field. */
  expectedValue?: string
  /**
   * For fill: whether the focused field held the typed text straight after
   * typing, as read by the field probe. `null`/absent means the probe could
   * not tell (cross-origin frame, date input, custom widget), and the
   * accessibility-tree signals decide alone.
   */
  typedLanded?: boolean | null
  /** For fill: what the focused field held when `typedLanded` is false. */
  fieldText?: string
}

function quoteFieldText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 80 ? `"${compact.slice(0, 80)}…"` : `"${compact}"`
}

export function verifyAction(
  before: ActionSignature,
  after: ActionSignature,
  options: VerifyOptions,
): ActionVerification {
  const urlChanged = before.url !== after.url
  const structureChanged = before.structureHash !== after.structureHash
  const scrollChanged = before.scrollY !== after.scrollY
  const valueChanged = before.targetValue !== after.targetValue
  const checkedChanged = before.targetChecked !== after.targetChecked
  const expandedChanged = before.targetExpanded !== after.targetExpanded

  // For a fill we can assert the stronger property: the field now holds what
  // we typed, not merely that something about it moved.
  const valueMatchesExpectation = options.expectedValue !== undefined && after.targetValue !== null
    ? after.targetValue.includes(options.expectedValue)
    : valueChanged

  let verified: boolean
  let reason: string

  switch (options.expectation) {
    case 'url':
      verified = urlChanged
      reason = verified ? `Navigated to ${after.url}` : 'The url did not change'
      break
    case 'value':
      // A structural change on its own proves nothing for a fill: typing into
      // an autocomplete field opens a suggestion popup whether or not the text
      // reached the field. When the probe saw the field, its answer wins.
      if (valueMatchesExpectation) {
        verified = true
        reason = 'The field holds the expected value'
      } else if (options.typedLanded === false) {
        verified = false
        reason = options.fieldText === undefined
          ? 'The text did not reach the field: no text field had keyboard focus while typing'
          : `The text did not reach the field: after typing, the focused field holds ${quoteFieldText(options.fieldText)}`
      } else if (options.typedLanded === true) {
        verified = true
        reason = 'The field received the typed text'
      } else {
        verified = structureChanged
        reason = verified ? 'The field did not update, but the page changed' : 'The field value did not change'
      }
      break
    case 'scroll':
      verified = scrollChanged || structureChanged
      reason = verified ? 'The viewport moved' : 'The page did not scroll'
      break
    case 'change':
      verified = urlChanged || structureChanged || valueChanged || checkedChanged || expandedChanged
      reason = verified
        ? (checkedChanged ? 'The control\'s selected state changed' : expandedChanged ? 'The element\'s expanded state changed' : 'The page changed')
        : 'Nothing on the page changed'
      break
    case 'none':
    default:
      verified = true
      reason = 'No verification required for this action'
      break
  }

  return {
    verified,
    urlChanged,
    structureChanged,
    scrollChanged,
    valueChanged,
    checkedChanged,
    expectation: options.expectation,
    reason,
  }
}
