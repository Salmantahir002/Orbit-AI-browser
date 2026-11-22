import type { CdpSession } from './cdpSession.js'
import { dispatchNativeKeyPress } from './nativeInput.js'
import { BrowserRuntimeError, type ElementHandle } from './runtimeContract.js'

/**
 * Reading and driving native `<select>` elements.
 *
 * A click on a native select opens an OS-drawn popup that no CDP input can
 * reach, which is why "click the dropdown, then click the option" never worked
 * for them. A focused, closed select does answer the keyboard: on Windows and
 * Linux each ArrowDown/ArrowUp moves the selection and fires input/change, the
 * same events a person's keyboard produces. That is the primary path here.
 */

const OBJECT_GROUP = 'orbit-select'
const MAX_KEY_STEPS = 400

export type SelectOptionInfo = { label: string; value: string; disabled: boolean }
export type NativeSelectState = { selectedIndex: number; multiple: boolean; options: SelectOptionInfo[] }

type RemoteObject = { objectId?: string; value?: unknown }

async function resolveObject(session: CdpSession, handle: ElementHandle): Promise<string | null> {
  if (typeof handle.backendNodeId !== 'number') return null
  const resolved = await session.send('DOM.resolveNode', { backendNodeId: handle.backendNodeId, objectGroup: OBJECT_GROUP }).catch(() => null)
  return (resolved?.object as RemoteObject | undefined)?.objectId ?? null
}

async function callOn<T>(session: CdpSession, objectId: string, declaration: string, args: unknown[] = []): Promise<T | null> {
  const response = await session.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: declaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    objectGroup: OBJECT_GROUP,
  })
  if (response.exceptionDetails) return null
  return ((response.result as RemoteObject | undefined)?.value ?? null) as T | null
}

const READ_SELECT = `function () {
  if (!this || this.tagName !== 'SELECT') return null;
  return {
    selectedIndex: this.selectedIndex,
    multiple: this.multiple,
    options: Array.from(this.options).map((o) => ({ label: (o.label || o.text || '').trim(), value: o.value, disabled: o.disabled })),
  };
}`

function norm(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Exact label, exact value, then prefix and substring of the label. Disabled options never match. */
export function matchOption(options: readonly SelectOptionInfo[], wanted: string): number {
  const target = norm(wanted)
  if (!target) return -1
  const tests: Array<(option: SelectOptionInfo) => boolean> = [
    (option) => norm(option.label) === target,
    (option) => norm(option.value) === target,
    (option) => norm(option.label).startsWith(target),
    (option) => norm(option.label).includes(target),
    (option) => target.includes(norm(option.label)) && norm(option.label).length >= 3,
  ]
  for (const test of tests) {
    const index = options.findIndex((option) => !option.disabled && test(option))
    if (index !== -1) return index
  }
  return -1
}

export function describeOptions(options: readonly SelectOptionInfo[], limit = 25): string {
  const labels = options.filter((option) => !option.disabled && option.label).map((option) => `"${option.label}"`)
  const shown = labels.slice(0, limit).join(', ')
  return labels.length > limit ? `${shown} … (${labels.length} options)` : shown
}

export async function withSelect<T>(session: CdpSession, handle: ElementHandle, action: (objectId: string, state: NativeSelectState) => Promise<T>): Promise<T | null> {
  try {
    const objectId = await resolveObject(session, handle)
    if (!objectId) return null
    const state = await callOn<NativeSelectState>(session, objectId, READ_SELECT)
    if (!state) return null
    return await action(objectId, state)
  } finally {
    await session.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => undefined)
  }
}

/**
 * Moves a focused native select to `index` with arrow keys, reading the
 * selection after each press (disabled options are skipped by the browser,
 * so the number of presses cannot be computed up front). Falls back to
 * setting `selectedIndex` and dispatching input/change only if the keyboard
 * had no effect — the one place the runtime assigns a value from script,
 * kept for platforms whose closed select ignores arrow keys.
 */
export async function chooseNativeOption(
  session: CdpSession,
  objectId: string,
  state: NativeSelectState,
  index: number,
): Promise<{ method: 'keyboard' | 'script'; selectedIndex: number }> {
  if (state.multiple) {
    throw new BrowserRuntimeError('INVALID_ARGUMENT', 'Multi-select lists are not supported by select_option; click each option instead')
  }
  await callOn(session, objectId, 'function () { this.focus(); }')

  let current = state.selectedIndex
  for (let step = 0; step < MAX_KEY_STEPS && current !== index; step++) {
    await dispatchNativeKeyPress(session, current < index || current === -1 ? 'ArrowDown' : 'ArrowUp')
    const next = await callOn<number>(session, objectId, 'function () { return this.selectedIndex; }')
    if (next === null || next === current) break // the keyboard is not moving it
    current = next
  }
  if (current === index) return { method: 'keyboard', selectedIndex: current }

  const scripted = await callOn<number>(session, objectId, `function (i) {
    this.selectedIndex = i;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return this.selectedIndex;
  }`, [index])
  if (scripted !== index) {
    throw new BrowserRuntimeError('ELEMENT_NOT_INTERACTABLE', 'The dropdown did not accept the selection')
  }
  return { method: 'script', selectedIndex: scripted }
}

/** Visible option-like texts, for an error that tells the planner what it can pick. */
export async function visibleOptionTexts(session: CdpSession): Promise<string[]> {
  const response = await session.send('Runtime.evaluate', {
    expression: `(() => {
      const seen = new Set();
      const out = [];
      for (const el of document.querySelectorAll('[role=option],[role=menuitem],[role=menuitemradio],[role=listbox] li,[role=menu] li')) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) continue;
        const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
        if (text && !seen.has(text)) { seen.add(text); out.push(text); }
        if (out.length >= 25) break;
      }
      return out;
    })()`,
    returnByValue: true,
  }).catch(() => null)
  const value = (response?.result as RemoteObject | undefined)?.value
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
