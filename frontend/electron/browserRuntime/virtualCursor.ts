import type { CdpSession } from './cdpSession.js'
import type { ViewportPoint } from './elementResolver.js'

/**
 * Visual agent overlay for the page the agent is driving: a virtual mouse
 * pointer that travels to each target, a click animation, and a slow blue
 * "breathing" glow around the viewport while a task is running.
 *
 * This is cosmetic only. It is painted alongside — never instead of — the real
 * trusted CDP input events dispatched in nativeInput.ts, every node is
 * `pointer-events: none`, and nothing here is ever read back as page state.
 *
 * Two constraints shape how the injected script is written, both learned the
 * hard way because they fail *silently*:
 *
 *  - **Trusted Types.** Google, YouTube and other CSP-hardened sites enforce
 *    `require-trusted-types-for 'script'`, under which any `innerHTML =` throws.
 *    Every node here is therefore built with `createElement`/`createElementNS`
 *    and `setAttribute`, which are not Trusted Types sinks.
 *  - **CSP `style-src`.** A `<style>` element or a `style="..."` attribute can be
 *    refused outright. Styling goes through CSSOM (`el.style.x = y`) and all
 *    motion through the Web Animations API, neither of which CSP governs.
 *
 * `Runtime.evaluate` resolves *successfully* when the injected script throws —
 * the error surfaces in `exceptionDetails` — so that field is inspected
 * explicitly. Without it, a page that rejects the overlay looks identical to
 * one that accepted it.
 */

/** Cosmetic travel duration; native input never waits for this animation. */
const MOVE_MS = 420
/** Press + ripple duration for a click. */
const CLICK_MS = 420
/** Beat of the ambient blue glow. */
const BREATHE_MS = 2600

const ACCENT = '#2f7bff'

/** Guards against a NaN/Infinity coordinate reaching the injected script. */
function coord(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

/** Single-quoted JS string literal, safe for inlining into the bootstrap. */
function jsString(value: string): string {
  return JSON.stringify(String(value))
}

/**
 * Installs `window.__pgAgentOverlay` in the page. Idempotent: it exits early if
 * already present, so it can be prepended to every call as a self-heal after a
 * navigation wipes the document.
 */
const BOOTSTRAP = `(function () {
  if (window.__pgAgentOverlay) return;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var api = {};
  var nodes = null;

  function styleOf(el, props) {
    for (var key in props) el.style.setProperty(key, props[key]);
    return el;
  }

  function host() { return document.body || document.documentElement; }

  function buildArrow() {
    // Built node-by-node: innerHTML would throw under Trusted Types.
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '26');
    svg.setAttribute('height', '26');
    svg.setAttribute('viewBox', '0 0 26 26');
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M3 1.5 L3 20.5 L8.4 15.4 L12.1 23.2 L15.6 21.5 L11.9 13.9 L18.9 13.9 Z');
    path.setAttribute('fill', '${ACCENT}');
    path.setAttribute('stroke', '#ffffff');
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return styleOf(svg, { display: 'block', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.55))' });
  }

  function build() {
    if (nodes && nodes.root.isConnected) return nodes;
    var parent = host();
    if (!parent) return null;

    var base = { position: 'fixed', 'pointer-events': 'none', margin: '0', padding: '0' };

    var root = styleOf(document.createElement('div'), Object.assign({}, base, {
      top: '0', left: '0', width: '0', height: '0', 'z-index': '2147483647',
    }));

    // Ambient glow: a viewport-sized frame, inset shadow only so the page stays readable.
    var glow = styleOf(document.createElement('div'), Object.assign({}, base, {
      inset: '0', top: '0', left: '0', width: '100vw', height: '100vh', opacity: '0',
      'box-shadow': 'inset 0 0 0 3px rgba(47,123,255,.55), inset 0 0 70px 10px rgba(47,123,255,.30)',
    }));

    var cursor = styleOf(document.createElement('div'), Object.assign({}, base, {
      top: '0', left: '0', width: '26px', height: '26px', opacity: '0',
      transform: 'translate3d(0,0,0)', 'will-change': 'transform',
    }));
    cursor.appendChild(buildArrow());

    // Ripple sits under the arrow tip; centred on the exact click point.
    var ripple = styleOf(document.createElement('div'), Object.assign({}, base, {
      top: '0', left: '0', width: '26px', height: '26px', 'margin-left': '-13px',
      'margin-top': '-13px', 'border-radius': '50%', opacity: '0',
      border: '2px solid ' + '${ACCENT}', background: 'rgba(47,123,255,.25)',
    }));

    var label = styleOf(document.createElement('div'), Object.assign({}, base, {
      top: '0', left: '0', opacity: '0', font: '600 11px/1.6 system-ui,-apple-system,Segoe UI,sans-serif',
      color: '#fff', background: 'rgba(17,24,39,.92)', padding: '2px 8px', 'border-radius': '999px',
      'white-space': 'nowrap', 'box-shadow': '0 2px 6px rgba(0,0,0,.4)', transform: 'translate(20px, 14px)',
    }));

    root.appendChild(glow);
    root.appendChild(ripple);
    root.appendChild(cursor);
    root.appendChild(label);
    parent.appendChild(root);

    nodes = { root: root, glow: glow, cursor: cursor, ripple: ripple, label: label, x: 0, y: 0, breathing: false, anim: null };
    return nodes;
  }

  function place(el, x, y) { el.style.left = x + 'px'; el.style.top = y + 'px'; }

  api.moveTo = function (x, y, text) {
    var n = build();
    if (!n) return;
    var fromX = n.x, fromY = n.y;
    var first = n.cursor.style.opacity === '0';
    n.x = x; n.y = y;

    n.cursor.style.opacity = '1';
    place(n.cursor, x, y);
    place(n.label, x, y);

    if (text) { n.label.textContent = text; n.label.style.opacity = '1'; }
    else { n.label.style.opacity = '0'; }

    // Animate the delta rather than left/top so the glide is compositor-driven.
    if (n.cursor.animate && !first) {
      var dx = fromX - x, dy = fromY - y;
      var opts = { duration: ${MOVE_MS}, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'none' };
      n.cursor.animate([
        { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0)' },
        { transform: 'translate3d(0,0,0)' },
      ], opts);
      n.label.animate([
        { transform: 'translate(' + (20 + dx) + 'px,' + (14 + dy) + 'px)' },
        { transform: 'translate(20px,14px)' },
      ], opts);
    } else if (n.cursor.animate) {
      n.cursor.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1)' }],
        { duration: ${MOVE_MS}, easing: 'ease-out' });
    }
  };

  api.clickAt = function (x, y) {
    var n = build();
    if (!n) return;
    api.moveTo(x, y, n.label.style.opacity === '1' ? n.label.textContent : '');
    place(n.ripple, x, y);
    if (!n.ripple.animate) return;
    n.ripple.animate(
      [
        { transform: 'scale(.2)', opacity: 0.95 },
        { transform: 'scale(2.6)', opacity: 0 },
      ],
      { duration: ${CLICK_MS}, easing: 'cubic-bezier(.2,.7,.3,1)' },
    );
    // The arrow dips as it presses, which reads as a real button press.
    n.cursor.animate(
      [
        { transform: 'scale(1)' },
        { transform: 'scale(.78)', offset: 0.35 },
        { transform: 'scale(1)' },
      ],
      { duration: ${CLICK_MS}, easing: 'ease-out' },
    );
  };

  api.pulse = function (text) {
    var n = build();
    if (!n) return;
    if (text) { n.label.textContent = text; n.label.style.opacity = '1'; }
    if (!n.cursor.animate) return;
    n.cursor.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }],
      { duration: 260, easing: 'ease-in-out' },
    );
  };

  api.nudge = function (x, y, dy) {
    var n = build();
    if (!n) return;
    api.moveTo(x, y, 'scroll');
    if (!n.cursor.animate) return;
    var travel = dy > 0 ? 10 : -10;
    n.cursor.animate(
      [
        { transform: 'translate3d(0,0,0)' },
        { transform: 'translate3d(0,' + travel + 'px,0)' },
        { transform: 'translate3d(0,0,0)' },
      ],
      { duration: 340, easing: 'ease-in-out' },
    );
  };

  api.breathe = function (on) {
    var n = build();
    if (!n) return;
    n.breathing = !!on;
    if (n.anim) { n.anim.cancel(); n.anim = null; }
    if (!on) {
      n.glow.style.opacity = '0';
      n.cursor.style.opacity = '0';
      n.label.style.opacity = '0';
      return;
    }
    n.glow.style.opacity = '1';
    if (!n.glow.animate) return;
    // Infinite Web Animations loop — CSS keyframes would need a <style> element,
    // which CSP style-src can refuse.
    n.anim = n.glow.animate(
      [{ opacity: 0.35 }, { opacity: 1 }, { opacity: 0.35 }],
      { duration: ${BREATHE_MS}, iterations: Infinity, easing: 'ease-in-out' },
    );
  };

  api.park = function (x, y) {
    var n = build();
    if (!n) return;
    n.x = x; n.y = y;
    place(n.cursor, x, y);
    place(n.label, x, y);
  };

  api.destroy = function () {
    if (nodes && nodes.root.isConnected) nodes.root.remove();
    nodes = null;
    try { delete window.__pgAgentOverlay; } catch (e) { window.__pgAgentOverlay = undefined; }
  };

  window.__pgAgentOverlay = api;

  // The document can still be parsing when this runs as a new-document script,
  // in which case there is no body to attach to yet.
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', function () { if (window.__pgAgentOverlay === api) build(); }, { once: true });
  }
})();`

/**
 * Runs a call against the overlay API, re-installing it first so the call
 * survives a navigation that wiped the previous document.
 *
 * Failures are reported, not thrown: the overlay is decoration, and a page that
 * refuses it must still be driveable. They are logged because a silent overlay
 * is indistinguishable from a broken one.
 */
async function evaluate(session: CdpSession, call: string): Promise<void> {
  try {
    const result = await session.send('Runtime.evaluate', {
      expression: `${BOOTSTRAP}\ntry { window.__pgAgentOverlay && ${call} } catch (e) { }`,
      awaitPromise: false,
      returnByValue: false,
      // The overlay is ours, not the page's; keep it out of the page's own world.
      userGesture: false,
    })

    // Runtime.evaluate resolves even when the script throws. Without this the
    // overlay can fail on every page and still look like it succeeded.
    if (result.exceptionDetails) {
      const details = result.exceptionDetails as { text?: string; exception?: { description?: string } }
      console.warn(
        `[virtual-cursor] Overlay script failed on target ${session.targetId}:`,
        details.exception?.description ?? details.text ?? 'unknown error',
      )
    }
  } catch (error) {
    console.warn(`[virtual-cursor] Could not reach target ${session.targetId}:`, error)
  }
}

/** Identifier of the new-document script per target, so it can be removed later. */
const persistentScripts = new Map<number, string>()

/**
 * Turns the agent overlay on or off for a target.
 *
 * While on, the overlay is also registered as a new-document script so the blue
 * breathing frame survives every navigation the agent makes rather than
 * vanishing on each page load.
 */
export async function setAgentOverlayActive(session: CdpSession, active: boolean): Promise<void> {
  const existing = persistentScripts.get(session.targetId)

  if (active) {
    if (!existing) {
      try {
        const registered = await session.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `${BOOTSTRAP}\ntry { window.__pgAgentOverlay && window.__pgAgentOverlay.breathe(true) } catch (e) { }`,
        })
        if (typeof registered.identifier === 'string') {
          persistentScripts.set(session.targetId, registered.identifier)
        }
      } catch (error) {
        console.warn(`[virtual-cursor] Could not persist the overlay across navigations:`, error)
      }
    }
    await evaluate(session, 'window.__pgAgentOverlay.breathe(true)')
    return
  }

  if (existing) {
    persistentScripts.delete(session.targetId)
    await session
      .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: existing })
      .catch(() => undefined)
  }
  await evaluate(session, 'window.__pgAgentOverlay.destroy()')
}

/**
 * Parks the cursor at a point without animating, so the next real move glides
 * from somewhere sensible instead of appearing out of nowhere.
 */
export async function parkVirtualCursor(session: CdpSession, point: ViewportPoint): Promise<void> {
  await evaluate(session, `window.__pgAgentOverlay.park(${coord(point.x)}, ${coord(point.y)})`)
}

/** Starts the glide; the page animates while native input proceeds. */
export async function moveVirtualCursor(session: CdpSession, point: ViewportPoint, label = ''): Promise<void> {
  await evaluate(session, `window.__pgAgentOverlay.moveTo(${coord(point.x)}, ${coord(point.y)}, ${jsString(label)})`)
}

/** Starts the click animation without adding an artificial input delay. */
export async function pulseVirtualCursorClick(session: CdpSession, point: ViewportPoint): Promise<void> {
  await evaluate(session, `window.__pgAgentOverlay.clickAt(${coord(point.x)}, ${coord(point.y)})`)
}

/** Moves to the scroll point and bobs the cursor in the scroll direction. */
export async function pulseVirtualCursorScroll(session: CdpSession, point: ViewportPoint, deltaY = 0): Promise<void> {
  await evaluate(session, `window.__pgAgentOverlay.nudge(${coord(point.x)}, ${coord(point.y)}, ${coord(deltaY)})`)
}

/** Bumps the cursor in place for keyboard actions, which have no click point. */
export async function pulseVirtualCursorTyping(session: CdpSession, label = 'type'): Promise<void> {
  await evaluate(session, `window.__pgAgentOverlay.pulse(${jsString(label)})`)
}
