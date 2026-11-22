import type { CdpSession } from './cdpSession.js'
import type { ElementHandle } from './runtimeContract.js'
import { BrowserRuntimeError } from './runtimeContract.js'

/**
 * Text-addressed targets for apps whose surface is not in the accessibility
 * tree.
 *
 * Google Slides draws a slide as SVG: the empty placeholders that say "Click
 * to add title" are SVG text, not controls, so the State Builder never gives
 * them an element id. Locating them by their visible text is how a person
 * finds them too. The match is resolved to a DOM node and clicked through the
 * same content-quad path as any other element, so coordinates never come from
 * page script.
 */

const OBJECT_GROUP = 'orbit-text-target'
const MAX_TEXT_LENGTH = 300
export const DEFAULT_READ_CHARS = 6_000
const MAX_READ_CHARS = 12_000

export type TextMatch = {
  handle: ElementHandle
  matchedText: string
  matches: number
}

/**
 * Runs in the page. Walks text nodes (HTML and SVG alike), climbs to the
 * smallest element whose text contains the needle, and ranks visible matches:
 * exact text first, then on-screen, then the largest (the slide being edited
 * beats its filmstrip thumbnail).
 */
function locateScript(needle: string, nth: number | null, preferOptions: boolean): string {
  return `(() => {
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const needle = norm(${JSON.stringify(needle)});
    const nth = ${nth === null ? 'null' : String(nth)};
    const preferOptions = ${preferOptions ? 'true' : 'false'};
    const OPTION = '[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=treeitem],[role=gridcell],li';
    if (!needle) return null;
    const root = document.body || document.documentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    const found = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      let el = node.parentElement;
      for (let depth = 0; el && depth < 5; depth += 1, el = el.parentElement) {
        const text = norm(el.textContent);
        if (text.length > needle.length * 3 + 40) break;
        if (text.includes(needle)) {
          if (!seen.has(el)) { seen.add(el); found.push({ el, text }); }
          break;
        }
      }
    }
    const visible = [];
    for (const item of found) {
      const style = getComputedStyle(item.el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const r = item.el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const onScreen = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      const inOption = preferOptions && !!item.el.closest(OPTION);
      visible.push({ ...item, exact: item.text === needle, onScreen, inOption, area: r.width * r.height });
    }
    if (visible.length === 0) return { element: null, matches: 0, hidden: found.length, text: '' };
    let chosen;
    if (nth !== null) {
      chosen = visible[nth - 1];
      if (!chosen) return { element: null, matches: visible.length, hidden: 0, text: '' };
    } else {
      chosen = [...visible].sort((a, b) =>
        (Number(b.inOption) - Number(a.inOption)) || (Number(b.exact) - Number(a.exact)) ||
        (Number(b.onScreen) - Number(a.onScreen)) || (b.area - a.area))[0];
    }
    return { element: chosen.el, matches: visible.length, hidden: found.length - visible.length, text: chosen.text.slice(0, 200) };
  })()`
}

type RemoteObject = { objectId?: string; value?: unknown; type?: string; subtype?: string }

async function callOn(session: CdpSession, objectId: string, declaration: string, returnByValue: boolean): Promise<RemoteObject | undefined> {
  const response = await session.send('Runtime.callFunctionOn', {
    objectId, functionDeclaration: declaration, returnByValue, objectGroup: OBJECT_GROUP,
  })
  return response.result as RemoteObject | undefined
}

export async function locateText(session: CdpSession, text: unknown, nth?: unknown, options: { preferOptions?: boolean } = {}): Promise<TextMatch> {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH) {
    throw new BrowserRuntimeError('INVALID_ARGUMENT', `text must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`)
  }
  let index: number | null = null
  if (nth !== undefined && nth !== null) {
    if (typeof nth !== 'number' || !Number.isInteger(nth) || nth < 1 || nth > 100) {
      throw new BrowserRuntimeError('INVALID_ARGUMENT', 'nth must be an integer between 1 and 100')
    }
    index = nth
  }

  try {
    const evaluated = await session.send('Runtime.evaluate', {
      expression: locateScript(text, index, options.preferOptions === true), returnByValue: false, objectGroup: OBJECT_GROUP,
    })
    if (evaluated.exceptionDetails) {
      throw new BrowserRuntimeError('CDP_ERROR', 'Text search failed in the page')
    }
    const container = evaluated.result as RemoteObject | undefined
    if (!container?.objectId) {
      throw new BrowserRuntimeError('ELEMENT_NOT_FOUND', `No visible text matching "${text}"`)
    }

    const summary = (await callOn(session, container.objectId,
      'function () { return { matches: this.matches, hidden: this.hidden, text: this.text, found: !!this.element } }', true))?.value as
      { matches: number; hidden: number; text: string; found: boolean } | undefined
    if (!summary?.found) {
      const hidden = summary?.hidden ? ` (${summary.hidden} hidden match${summary.hidden === 1 ? '' : 'es'})` : ''
      const counted = index !== null && summary?.matches ? ` — only ${summary.matches} visible match${summary.matches === 1 ? '' : 'es'}` : ''
      throw new BrowserRuntimeError('ELEMENT_NOT_FOUND', `No visible text matching "${text}"${counted}${hidden}`)
    }

    const element = await callOn(session, container.objectId, 'function () { return this.element }', false)
    if (!element?.objectId) {
      throw new BrowserRuntimeError('ELEMENT_NOT_FOUND', `No visible text matching "${text}"`)
    }
    const described = await session.send('DOM.describeNode', { objectId: element.objectId })
    const backendNodeId = (described.node as { backendNodeId?: number } | undefined)?.backendNodeId
    if (typeof backendNodeId !== 'number') {
      throw new BrowserRuntimeError('ELEMENT_NOT_INTERACTABLE', `Text "${text}" has no DOM node to click`)
    }

    return {
      handle: { elementId: 'text', axNodeId: '', role: 'text', name: summary.text || text, backendNodeId },
      matchedText: summary.text || text,
      matches: summary.matches,
    }
  } finally {
    await session.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => undefined)
  }
}

/**
 * Visible text of the page, or of one element. `innerText` skips SVG, which
 * is where Slides keeps every slide's text (editor and filmstrip), so SVG text
 * is collected per drawing and appended. Each drawing is one block, which in
 * the Slides filmstrip means one block per slide.
 */
function readScript(selector: string | null, maxChars: number): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const root = selector ? document.querySelector(selector) : (document.body || document.documentElement);
    if (!root) return { error: 'No element matches the selector', url: location.href };
    const flat = (s) => (s || '').replace(/[ \\t\\u00a0]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n').trim();
    const main = flat(root.innerText || '');
    const drawings = [];
    const svgs = root.tagName && root.tagName.toLowerCase() === 'svg' ? [root] : Array.from(root.querySelectorAll('svg'));
    for (const svg of svgs) {
      if (svg.parentElement && svg.parentElement.closest('svg')) continue;
      const r = svg.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const lines = [];
      for (const t of svg.querySelectorAll('text')) {
        const line = (t.textContent || '').replace(/\\s+/g, ' ').trim();
        if (line && lines[lines.length - 1] !== line) lines.push(line);
      }
      if (lines.length) drawings.push(lines.join(' | '));
    }
    let text = main;
    if (drawings.length) {
      text += (text ? '\\n\\n' : '') + 'DRAWN TEXT (SVG, one line per drawing/slide):\\n' +
        drawings.map((d, i) => (i + 1) + '. ' + d).join('\\n');
    }
    const max = ${maxChars};
    return { url: location.href, title: document.title, drawings: drawings.length,
      truncated: text.length > max, text: text.length > max ? text.slice(0, max) + '…' : text };
  })()`
}

export async function readVisibleText(session: CdpSession, selector?: unknown, maxChars?: unknown): Promise<{ value: unknown }> {
  if (selector !== undefined && (typeof selector !== 'string' || !selector.trim() || selector.length > 500)) {
    throw new BrowserRuntimeError('INVALID_ARGUMENT', 'selector must be a non-empty CSS selector')
  }
  const limit = typeof maxChars === 'number' && Number.isFinite(maxChars)
    ? Math.min(Math.max(Math.round(maxChars), 200), MAX_READ_CHARS)
    : DEFAULT_READ_CHARS
  const response = await session.send('Runtime.evaluate', {
    expression: readScript(typeof selector === 'string' ? selector : null, limit), returnByValue: true, timeout: 5_000,
  }, 6_000)
  if (response.exceptionDetails) {
    throw new BrowserRuntimeError('CDP_ERROR', 'Reading the page text failed (check the selector)')
  }
  return { value: (response.result as RemoteObject | undefined)?.value ?? null }
}
