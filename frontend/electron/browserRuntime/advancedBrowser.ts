import type { CdpSession } from './cdpSession.js'
import { BrowserRuntimeError } from './runtimeContract.js'

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

function number(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new BrowserRuntimeError('INVALID_ARGUMENT', `${name} must be finite and between ${min} and ${max}`)
  }
  return value
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) {
    throw new BrowserRuntimeError('INVALID_ARGUMENT', `${name} must be a non-empty string of at most 20000 characters`)
  }
  return value
}

/** Evaluation is confined to the registered guest page, never the shell or Node. */
export async function evaluatePage(session: CdpSession, params: EvaluateParams): Promise<BrowserObservation> {
  const expression = text(params.expression, 'expression')
  const timeout = number(params.timeoutMs ?? 5_000, 'timeoutMs', 1, 15_000)
  const response = await session.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, timeout,
  }, timeout + 1_000)
  if (response.exceptionDetails) {
    throw new BrowserRuntimeError('CDP_ERROR', `Script evaluation failed: ${JSON.stringify(response.exceptionDetails)}`)
  }
  const result = response.result as { value?: unknown; type?: string; unserializableValue?: string } | undefined
  if (result?.unserializableValue || (result?.type !== 'undefined' && result?.value === undefined)) {
    throw new BrowserRuntimeError('INVALID_ARGUMENT', 'Return JSON-serializable data from evaluate (not DOM nodes or functions)')
  }
  const value = result?.value ?? null
  if (JSON.stringify(value).length > 100_000) {
    throw new BrowserRuntimeError('INVALID_ARGUMENT', 'Evaluation result exceeds 100000 characters; select fewer fields or rows')
  }
  return { value }
}

// Selectors cross open shadow roots using explicit "host >>> descendant" segments.
const QUERY = `const query = (selector, root = document) => {
  const parts = selector.split('>>>').map(s => s.trim());
  for (const part of parts.slice(0, -1)) {
    root = root.querySelector(part)?.shadowRoot;
    if (!root) return [];
  }
  return Array.from(root.querySelectorAll(parts[parts.length - 1]));
};`

export async function elementBounds(session: CdpSession, params: BoundsParams): Promise<BrowserObservation> {
  const selector = text(params.selector, 'selector')
  return evaluatePage(session, { expression: `(() => { ${QUERY}
    return query(${JSON.stringify(selector)}).slice(0, 100).map(el => {
      const r = el.getBoundingClientRect();
      const left = Math.max(0, r.left), top = Math.max(0, r.top);
      const right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
      return { x: r.x, y: r.y, width: r.width, height: r.height,
        centerX: (left + right) / 2, centerY: (top + bottom) / 2,
        visible: right > left && bottom > top && getComputedStyle(el).visibility !== 'hidden',
        text: (el.innerText || el.textContent || '').trim().slice(0, 200) };
    });
  })()` })
}

export async function dispatchMouse(session: CdpSession, params: MouseParams): Promise<BrowserObservation> {
  if (!['mousePressed', 'mouseMoved', 'mouseReleased', 'mouseWheel'].includes(params.type)) {
    throw new BrowserRuntimeError('INVALID_ARGUMENT', 'Unsupported mouse event type')
  }
  const viewport = await session.send('Page.getLayoutMetrics')
  const size = (viewport.cssVisualViewport ?? viewport.visualViewport) as { clientWidth: number; clientHeight: number }
  const x = number(params.x, 'x', 0, size.clientWidth - 0.01)
  const y = number(params.y, 'y', 0, size.clientHeight - 0.01)
  const button = params.button ?? (params.type === 'mousePressed' || params.type === 'mouseReleased' ? 'left' : 'none')
  if (!['none', 'left', 'right', 'middle'].includes(button)) throw new BrowserRuntimeError('INVALID_ARGUMENT', 'Invalid mouse button')
  const mask = { none: 0, left: 1, right: 2, middle: 4 }[button]
  const buttons = number(params.buttons ?? (params.type === 'mousePressed' ? mask : 0), 'buttons', 0, 7)
  const modifiers = number(params.modifiers ?? 0, 'modifiers', 0, 15)
  const clickCount = number(params.clickCount ?? (params.type === 'mousePressed' || params.type === 'mouseReleased' ? 1 : 0), 'clickCount', 0, 3)
  if (![buttons, modifiers, clickCount].every(Number.isInteger)) throw new BrowserRuntimeError('INVALID_ARGUMENT', 'Mouse masks/counts must be integers')
  const event: Record<string, unknown> = { type: params.type, x, y, button, buttons, modifiers, clickCount }
  if (params.type === 'mouseWheel') {
    event.deltaX = number(params.deltaX ?? 0, 'deltaX', -100_000, 100_000)
    event.deltaY = number(params.deltaY ?? 0, 'deltaY', -100_000, 100_000)
  }
  await session.send('Input.dispatchMouseEvent', event)
  return { value: { dispatched: event } }
}

export async function drag(session: CdpSession, params: DragParams): Promise<BrowserObservation> {
  const steps = number(params.steps ?? 16, 'steps', 2, 60)
  if (!Number.isInteger(steps)) throw new BrowserRuntimeError('INVALID_ARGUMENT', 'steps must be an integer')
  // Validate all endpoints before pressing so malformed input cannot leave a button down.
  for (const key of ['startX', 'startY', 'endX', 'endY'] as const) number(params[key], key, 0, 100_000)
  await dispatchMouse(session, { type: 'mouseMoved', x: params.startX, y: params.startY })
  let x = params.startX, y = params.startY
  try {
    await dispatchMouse(session, { type: 'mousePressed', x, y, button: 'left', buttons: 1 })
    for (let i = 1; i <= steps; i++) {
      x = params.startX + (params.endX - params.startX) * i / steps
      y = params.startY + (params.endY - params.startY) * i / steps
      await dispatchMouse(session, { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
      await new Promise(resolve => setTimeout(resolve, 16))
    }
  } finally {
    // Use the protocol directly for release even if the viewport resized during the drag.
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
  return { value: { dispatched: true, verificationRequired: 'Inspect the resulting DOM order before claiming success' } }
}

type CapturedRow = { key: string; index: number; cells: string[] }

/** Read each recycled viewport afresh and merge by data identity, never by DOM identity. */
export async function extractVirtualTable(session: CdpSession, params: VirtualTableParams): Promise<BrowserObservation> {
  const rowSelector = text(params.rowSelector, 'rowSelector')
  const scrollSelector = text(params.scrollSelector, 'scrollSelector')
  const keyAttribute = text(params.keyAttribute, 'keyAttribute')
  const indexAttribute = text(params.indexAttribute, 'indexAttribute')
  let columns: Record<string, string>
  try { columns = JSON.parse(text(params.columns, 'columns')) } catch { throw new BrowserRuntimeError('INVALID_ARGUMENT', 'columns must be a JSON object mapping column titles to cell selectors') }
  if (!columns || Array.isArray(columns) || typeof columns !== 'object' || !Object.keys(columns).length || Object.keys(columns).length > 20 || !Object.values(columns).every(v => typeof v === 'string' && v.trim())) {
    throw new BrowserRuntimeError('INVALID_ARGUMENT', 'Provide 1–20 named column selectors')
  }
  const count = number(params.count ?? 20, 'count', 1, 100)
  const startIndex = number(params.startIndex ?? 0, 'startIndex', 0, 1_000_000)
  if (!Number.isInteger(count) || !Number.isInteger(startIndex)) throw new BrowserRuntimeError('INVALID_ARGUMENT', 'count and startIndex must be integers')
  const read = async () => (await evaluatePage(session, { expression: `(() => { ${QUERY}
    const root = query(${JSON.stringify(scrollSelector)})[0];
    if (!root) throw Error('Scroll container not found');
    const r = root.getBoundingClientRect();
    const rows = query(${JSON.stringify(rowSelector)}).map(row => {
      const raw = row.getAttribute(${JSON.stringify(indexAttribute)});
      return { key: row.getAttribute(${JSON.stringify(keyAttribute)}), index: raw === null ? null : Number(raw),
        cells: ${JSON.stringify(Object.values(columns))}.map(selector => {
          const cell = row.querySelector(selector); return cell ? (cell.innerText || cell.textContent || '').trim() : null;
        }) };
    });
    return { rows, top: root.scrollTop, height: root.clientHeight,
      x: (Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,
      y: (Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2 };
  })()` })).value as { rows: CapturedRow[]; top: number; height: number; x: number; y: number }
  const collected = new Map<number, CapturedRow>()
  const keys = new Map<string, number>()
  const deadline = Date.now() + 25_000
  let wheels = 0, stalled = 0, lastSignature = ''
  const initial = await read()
  // Start at the top using native wheel input, not scrollTop assignment.
  if (initial.top > 0) {
    await dispatchMouse(session, { type: 'mouseWheel', x: initial.x, y: initial.y, deltaY: -100_000 })
    wheels++
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  while (Date.now() < deadline && wheels < 100) {
    const view = await read()
    for (const row of view.rows) {
      if (!Number.isInteger(row.index) || row.index < startIndex || row.index >= startIndex + count) continue
      if (typeof row.key !== 'string' || !row.key || !row.cells.every(cell => typeof cell === 'string')) continue
      const previous = collected.get(row.index)
      if ((previous && previous.key !== row.key) || (keys.has(row.key) && keys.get(row.key) !== row.index)) {
        throw new BrowserRuntimeError('CDP_ERROR', 'Row identities changed during extraction; wait for filtering/sorting to settle and retry')
      }
      collected.set(row.index, row)
      keys.set(row.key, row.index)
    }
    if (collected.size === count) break
    const signature = JSON.stringify([view.top, view.rows])
    stalled = signature === lastSignature ? stalled + 1 : 0
    if (stalled >= 8) break
    lastSignature = signature
    // Overlap viewports so a short/recycled row cannot fall between samples.
    await dispatchMouse(session, { type: 'mouseWheel', x: view.x, y: view.y, deltaY: Math.max(1, Math.floor(view.height / 2)) })
    wheels++
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  const rows = [...collected.values()].sort((a, b) => a.index - b.index)
  const missingIndices = Array.from({ length: count }, (_, i) => startIndex + i).filter(i => !collected.has(i))
  const clean = (value: string) => value.replace(/[\t\r\n]+/g, ' ')
  const tsv = [Object.keys(columns), ...rows.map(row => row.cells)].map(cells => cells.map(clean).join('\t')).join('\n')
  return { value: { complete: missingIndices.length === 0, requested: count, captured: rows.length, missingIndices, wheelEvents: wheels, rows, tsv } }
}
