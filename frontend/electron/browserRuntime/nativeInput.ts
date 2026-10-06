import type { CdpSession } from './cdpSession.js'
import type { ViewportPoint } from './elementResolver.js'
import { BrowserRuntimeError } from './runtimeContract.js'

/**
 * Native input dispatch over `Input.dispatchMouseEvent` and
 * `Input.dispatchKeyEvent`.
 *
 * These produce trusted events indistinguishable from a real user's, so pages
 * relying on `event.isTrusted`, pointer capture, or focus side effects behave
 * correctly. Nothing here calls `element.click()` or assigns `.value`.
 */

export type MouseButton = 'left' | 'right' | 'middle'

const BUTTON_MASK: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 }

/** Modifier bitmask used by Input.dispatch*Event. */
export const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const

const MAX_TYPE_LENGTH = 5_000

type KeyDefinition = { key: string; code: string; keyCode: number; text?: string }

/**
 * Named non-printable keys. Printable characters derive their key code below,
 * so this table only needs the keys that carry semantics for page handlers.
 */
const NAMED_KEYS: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}

/**
 * US-layout physical keys for punctuation, shifted and unshifted. Chip and
 * token widgets (mail recipient fields, tag inputs) commonly decide on
 * `keyCode` whether a comma or semicolon ends an entry, so reporting 0 for
 * them silently disables that behaviour.
 */
const PUNCTUATION_KEYS: Record<string, { code: string; keyCode: number }> = {
  ' ': { code: 'Space', keyCode: 32 },
  ',': { code: 'Comma', keyCode: 188 }, '<': { code: 'Comma', keyCode: 188 },
  '.': { code: 'Period', keyCode: 190 }, '>': { code: 'Period', keyCode: 190 },
  ';': { code: 'Semicolon', keyCode: 186 }, ':': { code: 'Semicolon', keyCode: 186 },
  '/': { code: 'Slash', keyCode: 191 }, '?': { code: 'Slash', keyCode: 191 },
  '-': { code: 'Minus', keyCode: 189 }, '_': { code: 'Minus', keyCode: 189 },
  '=': { code: 'Equal', keyCode: 187 }, '+': { code: 'Equal', keyCode: 187 },
  "'": { code: 'Quote', keyCode: 222 }, '"': { code: 'Quote', keyCode: 222 },
  '[': { code: 'BracketLeft', keyCode: 219 }, '{': { code: 'BracketLeft', keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 }, '}': { code: 'BracketRight', keyCode: 221 },
  '\\': { code: 'Backslash', keyCode: 220 }, '|': { code: 'Backslash', keyCode: 220 },
  '`': { code: 'Backquote', keyCode: 192 }, '~': { code: 'Backquote', keyCode: 192 },
  '!': { code: 'Digit1', keyCode: 49 }, '@': { code: 'Digit2', keyCode: 50 },
  '#': { code: 'Digit3', keyCode: 51 }, '$': { code: 'Digit4', keyCode: 52 },
  '%': { code: 'Digit5', keyCode: 53 }, '^': { code: 'Digit6', keyCode: 54 },
  '&': { code: 'Digit7', keyCode: 55 }, '*': { code: 'Digit8', keyCode: 56 },
  '(': { code: 'Digit9', keyCode: 57 }, ')': { code: 'Digit0', keyCode: 48 },
}

/**
 * Best-effort key code for a printable character. Letters, digits and US
 * punctuation map to their standard codes; anything else reports 0, which
 * pages overwhelmingly ignore in favour of `key`/`text`.
 */
function printableKeyDefinition(character: string): KeyDefinition {
  const punctuation = PUNCTUATION_KEYS[character]
  if (punctuation) return { key: character, code: punctuation.code, keyCode: punctuation.keyCode, text: character }

  const upper = character.toUpperCase()
  const isLetter = upper >= 'A' && upper <= 'Z'
  const isDigit = character >= '0' && character <= '9'
  const keyCode = isLetter || isDigit ? upper.charCodeAt(0) : 0
  const code = isLetter ? `Key${upper}` : isDigit ? `Digit${character}` : ''

  return { key: character, code, keyCode, text: character }
}

function resolveKeyDefinition(key: string): KeyDefinition {
  if (NAMED_KEYS[key]) return NAMED_KEYS[key]
  if ([...key].length === 1) return printableKeyDefinition(key)

  throw new BrowserRuntimeError('INVALID_ARGUMENT', `Unsupported key: ${key}`)
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

/**
 * A full press: move the pointer first so hover styles and mouseover handlers
 * fire, then press and release at the same point.
 */
export async function dispatchNativeClick(
  session: CdpSession,
  point: ViewportPoint,
  options: { button?: MouseButton; clickCount?: number } = {},
): Promise<void> {
  const button = options.button ?? 'left'
  const clickCount = Math.min(Math.max(options.clickCount ?? 1, 1), 3)
  const buttons = BUTTON_MASK[button]

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, clickCount: 0,
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button, buttons, clickCount,
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount,
  })
}

export async function dispatchNativeKeyPress(
  session: CdpSession,
  key: string,
  modifiers = 0,
): Promise<void> {
  const definition = resolveKeyDefinition(key)
  // A modified key (Ctrl+A) is a shortcut, not text input, so no text payload.
  const emitsText = modifiers === 0 || modifiers === MODIFIER.shift

  await session.send('Input.dispatchKeyEvent', {
    type: emitsText && definition.text ? 'keyDown' : 'rawKeyDown',
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
    text: emitsText ? definition.text : undefined,
    unmodifiedText: emitsText ? definition.text : undefined,
    modifiers,
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
    modifiers,
  })
}

/**
 * Types text one character at a time as real key events.
 *
 * `Input.insertText` would be a single round trip, but it does not produce
 * keydown/keyup, and controlled inputs in React/Vue and most autocomplete
 * widgets only update in response to those. Correctness wins over speed here.
 */
export async function dispatchNativeType(
  session: CdpSession,
  text: string,
  delayMs = 0,
): Promise<void> {
  if (text.length > MAX_TYPE_LENGTH) {
    throw new BrowserRuntimeError('INVALID_ARGUMENT', `Text exceeds ${MAX_TYPE_LENGTH} characters`)
  }

  // Iterate code points so emoji and surrogate pairs are not split.
  for (const character of text) {
    if (character === '\n') {
      await dispatchNativeKeyPress(session, 'Enter')
    } else {
      await dispatchNativeKeyPress(session, character)
    }
    await delay(delayMs)
  }
}

export async function dispatchNativeScroll(
  session: CdpSession,
  point: ViewportPoint,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY, button: 'none', buttons: 0,
  })
}

/** Selects the whole field and deletes it, without touching `.value`. */
export async function clearFocusedField(session: CdpSession): Promise<void> {
  const selectAllModifier = process.platform === 'darwin' ? MODIFIER.meta : MODIFIER.ctrl
  await dispatchNativeKeyPress(session, 'a', selectAllModifier)
  await dispatchNativeKeyPress(session, 'Backspace')
  await dispatchNativeKeyPress(session, 'Delete')
}
