import type { CdpSession } from './cdpSession.js'
import type { ElementHandle } from './runtimeContract.js'

/**
 * Field Probe.
 *
 * Answers the two questions a `fill` must settle before it can claim success:
 * did the click put keyboard focus in an editable field, and did the typed text
 * actually end up in that field?
 *
 * The accessibility tree cannot answer either reliably. A token field such as
 * Gmail's "To" box turns a typed address into a chip and empties itself, a
 * contenteditable often reports no `value`, and an autocomplete popup changes
 * the tree's structure whether or not a single character landed. Judging a
 * fill by "the page changed" is exactly how a recipient that never arrived got
 * reported as entered.
 *
 * The probe only reads `document.activeElement` and the focused field's
 * text — it never assigns a value, dispatches an event, or moves focus. All
 * input still goes through native key events.
 */

/** Input types whose value the browser normalises, so typed text cannot be compared literally. */
const NORMALISED_INPUT_TYPES = ['date', 'datetime-local', 'time', 'month', 'week', 'color', 'range', 'number']

export type FocusedField =
  /** Focus is in a text field; `text` is what it holds now. */
  | { state: 'editable'; text: string; relatedToTarget: boolean; inputType: string }
  /** Focus is in a field whose value cannot be compared to typed text (date, number, …). */
  | { state: 'unverifiable'; relatedToTarget: boolean }
  /** Focus is inside a cross-origin frame the probe cannot look into. */
  | { state: 'opaque' }
  /** Focus is on something that is not a text field (a custom listbox, a button). */
  | { state: 'other'; relatedToTarget: boolean }
  /** Nothing has focus — keystrokes go to the document body. */
  | { state: 'none' }

export type FieldProbeResult = {
  focused: FocusedField
  /** Whether the target element is itself a text field, or null when it could not be resolved. */
  targetEditable: boolean | null
}

/**
 * Runs with `this` bound to the target node when it resolves, and to nothing
 * otherwise. Focus is followed through open shadow roots and same-origin
 * frames, where rich editors keep their real input.
 */
const PROBE_FUNCTION = `function (normalisedTypes) {
  const target = this && this.nodeType === 1 ? this : null;
  const editableInput = (el) => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' &&
    !/^(button|submit|reset|checkbox|radio|file|image|hidden)$/i.test(el.type || ''));
  const isEditable = (el) => !!el && (editableInput(el) || el.isContentEditable === true);

  let doc = target ? target.ownerDocument : document;
  let el = doc.activeElement;
  for (let hops = 0; el && hops < 25; hops += 1) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      let inner = null;
      try { inner = el.contentDocument; } catch (error) { inner = null; }
      if (!inner) return { focused: { state: 'opaque' }, targetEditable: target ? isEditable(target) : null };
      el = inner.activeElement;
      continue;
    }
    break;
  }

  const related = (node) => !!target && !!node &&
    (node === target || target.contains(node) || node.contains(target));
  const targetEditable = target ? isEditable(target) : null;
  const isBody = !el || (el.ownerDocument && el === el.ownerDocument.body && !el.isContentEditable);

  if (isBody) return { focused: { state: 'none' }, targetEditable };
  if (!isEditable(el)) return { focused: { state: 'other', relatedToTarget: related(el) }, targetEditable };

  const inputType = el.tagName === 'INPUT' ? String(el.type || 'text').toLowerCase() : '';
  if (normalisedTypes.includes(inputType)) {
    return { focused: { state: 'unverifiable', relatedToTarget: related(el) }, targetEditable };
  }

  const raw = editableInput(el) ? el.value : (el.innerText || el.textContent || '');
  return {
    focused: { state: 'editable', text: String(raw || '').slice(0, 20000), relatedToTarget: related(el), inputType },
    targetEditable,
  };
}`

/**
 * Reads a recipient field: the raw text still in its input, and every address
 * already shown around it as a chip. The chip area is the largest ancestor of
 * the input that contains no other visible text field — so the To row, never
 * the Subject or body next to it. Chips usually show a contact's name, so
 * their email-bearing attributes count as well as their text. The input's own
 * suggestion popup (aria-controls/aria-owns) is skipped, since it echoes the
 * typed address before anything is committed.
 */
const RECIPIENT_PROBE_FUNCTION = `function () {
  const target = this && this.nodeType === 1 ? this : null;
  const textEntry = (el) => !!el && el.nodeType === 1 && (el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|file|image|hidden)$/i.test(el.type || '')) ||
    el.isContentEditable === true);
  const visible = (el) => el.getClientRects().length > 0;

  let active = (target ? target.ownerDocument : document).activeElement;
  for (let hops = 0; active && hops < 25; hops += 1) {
    if (active.shadowRoot && active.shadowRoot.activeElement) { active = active.shadowRoot.activeElement; continue; }
    if (active.tagName === 'IFRAME' || active.tagName === 'FRAME') {
      let inner = null;
      try { inner = active.contentDocument; } catch (error) { inner = null; }
      active = inner ? inner.activeElement : null;
      continue;
    }
    break;
  }

  const field = textEntry(active) ? active : (textEntry(target) ? target : null);
  if (!field) return null;
  const isInput = field.tagName === 'INPUT' || field.tagName === 'TEXTAREA';
  const fieldText = String((isInput ? field.value : field.innerText) || '').slice(0, 5000);

  let area = field;
  for (let level = 0; level < 10 && area.parentElement; level += 1) {
    const parent = area.parentElement;
    const otherField = [...parent.querySelectorAll('input, textarea, [contenteditable]')].some((el) =>
      el !== field && !field.contains(el) && !el.contains(field) && textEntry(el) && visible(el));
    if (otherField) break;
    area = parent;
  }

  const popups = ['aria-controls', 'aria-owns']
    .flatMap((name) => (field.getAttribute(name) || '').split(/\\s+/))
    .map((id) => id && field.ownerDocument.getElementById(id))
    .filter(Boolean);
  const inPopup = (el) => popups.some((popup) => popup === el || popup.contains(el));

  const parts = [];
  for (const el of [area, ...area.querySelectorAll('*')]) {
    if (el === field || inPopup(el) || !visible(el)) continue;
    for (const name of ['data-hovercard-id', 'email', 'data-email', 'data-name', 'title', 'aria-label']) {
      const value = el.getAttribute(name);
      if (value) parts.push(value);
    }
    if (parts.length > 2000) break;
  }
  const popupText = popups.map((popup) => popup.innerText || '').join(' ');
  let areaText = area.innerText || '';
  if (popupText) areaText = areaText.split(popupText).join(' ');

  return {
    fieldText,
    isInput,
    recipientsText: (areaText + ' ' + parts.join(' ')).toLowerCase().slice(0, 50000),
  };
}`

export type RecipientField = {
  /** Raw text still in the input — typed, not yet a recipient. */
  fieldText: string
  /** Whether the field is an `<input>`/`<textarea>`, where raw text and chips are separate. */
  isInput: boolean
  /** Lower-cased text and email-bearing attributes of the chip area around the field. */
  recipientsText: string
}

const PROBE_OBJECT_GROUP = 'agent-field-probe'

async function callOnTarget(
  session: CdpSession,
  handle: ElementHandle,
  functionDeclaration: string,
  args: unknown[],
): Promise<unknown> {
  if (typeof handle.backendNodeId === 'number') {
    const resolved = await session
      .send('DOM.resolveNode', { backendNodeId: handle.backendNodeId, objectGroup: PROBE_OBJECT_GROUP })
      .catch(() => null)
    const objectId = (resolved?.object as { objectId?: unknown } | undefined)?.objectId

    if (typeof objectId === 'string') {
      try {
        const response = await session.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration,
          arguments: args.map((value) => ({ value })),
          returnByValue: true,
        })
        return (response.result as { value?: unknown } | undefined)?.value
      } finally {
        await session.send('Runtime.releaseObjectGroup', { objectGroup: PROBE_OBJECT_GROUP }).catch(() => undefined)
      }
    }
  }

  // The target node is gone (a widget re-rendered it on focus): still read
  // what has focus, just without the target to anchor on.
  const response = await session.send('Runtime.evaluate', {
    expression: `(${functionDeclaration}).apply(null, ${JSON.stringify(args)})`,
    returnByValue: true,
  })
  return (response.result as { value?: unknown } | undefined)?.value
}

/** Reads a recipient field and its chips, or null when no text field can be found. */
export async function probeRecipientField(session: CdpSession, handle: ElementHandle): Promise<RecipientField | null> {
  try {
    const value = await callOnTarget(session, handle, RECIPIENT_PROBE_FUNCTION, [])
    if (!value || typeof value !== 'object') return null
    const candidate = value as Partial<RecipientField>
    if (typeof candidate.fieldText !== 'string' || typeof candidate.recipientsText !== 'string') return null
    return { fieldText: candidate.fieldText, isInput: candidate.isInput === true, recipientsText: candidate.recipientsText }
  } catch {
    return null
  }
}

/** Whether the address already shows as a recipient (a chip), not merely as text typed in the input. */
export function hasRecipient(field: RecipientField, address: string): boolean {
  return field.recipientsText.includes(address.toLowerCase())
}

function asProbeResult(value: unknown): FieldProbeResult | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<FieldProbeResult>
  if (!candidate.focused || typeof candidate.focused !== 'object') return null
  return {
    focused: candidate.focused as FocusedField,
    targetEditable: typeof candidate.targetEditable === 'boolean' ? candidate.targetEditable : null,
  }
}

/**
 * Reports where keyboard focus is and what that field holds, relative to
 * `handle` when one is given. A probe that cannot run reports `opaque`, which
 * callers treat as "unknown" rather than as a failure.
 */
export async function probeFocusedField(session: CdpSession, handle?: ElementHandle): Promise<FieldProbeResult> {
  const unknown: FieldProbeResult = { focused: { state: 'opaque' }, targetEditable: null }

  try {
    const anchor: ElementHandle = handle ?? { elementId: '', axNodeId: '', role: '', name: '' }
    return asProbeResult(await callOnTarget(session, anchor, PROBE_FUNCTION, [NORMALISED_INPUT_TYPES])) ?? unknown
  } catch {
    return unknown
  }
}

function normaliseForComparison(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Whether `actual` contains `expected`. Whitespace and case are ignored, and
 * masked inputs that insert their own punctuation ("(555) 123-4567" for typed
 * "5551234567") still match on their letters and digits.
 */
export function fieldHoldsText(actual: string, expected: string): boolean {
  const want = normaliseForComparison(expected)
  if (!want) return true
  const have = normaliseForComparison(actual)
  if (have.includes(want)) return true

  const alphanumeric = (value: string) => value.replace(/[^\p{L}\p{N}]/gu, '')
  const wantCore = alphanumeric(want)
  return wantCore.length > 0 && alphanumeric(have).includes(wantCore)
}

const EMAIL_ADDRESS = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/

/**
 * Splits a fill value into email addresses when — and only when — it is
 * nothing but a comma/semicolon/space separated list of them.
 */
export function parseEmailList(value: string): string[] | null {
  const parts = value.split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 50) return null
  return parts.every((part) => EMAIL_ADDRESS.test(part)) ? parts : null
}

/**
 * Mail and invite composers name their recipient box "To", "Cc", "Bcc",
 * "Recipients", "Add guests"… These fields hold addresses as chips, and a typed
 * address only becomes a recipient once the field commits it.
 */
const RECIPIENT_FIELD_NAME = /^(to|cc|bcc)\b|\brecipients?\b|\b(add )?(guests|attendees|invitees)\b/i

export function isRecipientField(handle: ElementHandle): boolean {
  return RECIPIENT_FIELD_NAME.test(handle.name.trim())
}
