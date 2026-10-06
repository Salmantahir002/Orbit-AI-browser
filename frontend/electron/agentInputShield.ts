import { WebContentsView } from 'electron'
import type { BrowserWindow, Rectangle } from 'electron'

/**
 * Agent Input Shield.
 *
 * While the agent drives a tab, the user's own mouse, wheel and keyboard must
 * not reach that page: a stray click mid-task moves focus, closes a menu the
 * agent just opened, or types into the field it is filling. The guest is a
 * native WebContentsView composited above the shell, so nothing in the
 * React DOM can cover it. Instead a second, transparent WebContentsView is
 * stacked exactly over the tab and swallows every real input event.
 *
 * The agent is unaffected: it drives the page with CDP `Input.dispatch*`
 * events, which go straight to the guest's own renderer and never through
 * on-screen hit testing.
 *
 * When the user tries to interact, the shield shows a short-lived toast
 * explaining that agent mode is active, with a Stop button. The page has no
 * preload and no Node access; Stop is reported by navigating to a sentinel
 * URL that main intercepts and cancels.
 */

const STOP_URL = 'https://agent-shield.invalid/stop'

const SHIELD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agent mode active</title>
<style>
  :root {
    --accent: #2f7bff;
    --accent-2: #7c5cff;
    --glass: rgba(16, 18, 26, 0.8);
    --border: rgba(255, 255, 255, 0.1);
    --text: #f4f6fb;
    --muted: rgba(222, 228, 242, 0.7);
    --danger: #ff5d5d;
    --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
  body {
    cursor: not-allowed;
    user-select: none;
    -webkit-user-select: none;
    font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  .ripple {
    position: fixed;
    width: 34px;
    height: 34px;
    margin: -17px 0 0 -17px;
    border-radius: 50%;
    border: 1.5px solid rgba(47, 123, 255, 0.85);
    background: radial-gradient(circle, rgba(47, 123, 255, 0.16) 0%, rgba(47, 123, 255, 0) 70%);
    box-shadow: 0 0 14px rgba(47, 123, 255, 0.35);
    pointer-events: none;
    animation: ripple 560ms var(--ease) forwards;
  }
  .ripple::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 15px;
    height: 1.5px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.9);
    transform: translate(-50%, -50%) rotate(-45deg);
  }
  @keyframes ripple {
    from { transform: scale(0.5); opacity: 1; }
    to { transform: scale(1.35); opacity: 0; }
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  .toast {
    position: fixed;
    left: 50%;
    bottom: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
    width: max-content;
    max-width: calc(100vw - 24px);
    height: 38px;
    padding: 0 4px 0 6px;
    border-radius: 999px;
    background: var(--glass);
    border: 1px solid var(--border);
    box-shadow:
      0 10px 28px rgba(0, 0, 0, 0.38),
      0 1px 3px rgba(0, 0, 0, 0.28),
      inset 0 1px 0 rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(18px) saturate(160%);
    color: var(--text);
    cursor: default;
    opacity: 0;
    pointer-events: none;
    transform: translate(-50%, 10px) scale(0.97);
    transition: opacity 200ms var(--ease), transform 300ms var(--ease);
  }
  .toast::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1px;
    background: linear-gradient(110deg, rgba(47, 123, 255, 0.65), rgba(124, 92, 255, 0.3) 45%, rgba(255, 255, 255, 0) 75%);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
  }
  .toast.visible {
    opacity: 1;
    pointer-events: auto;
    transform: translate(-50%, 0) scale(1);
  }
  .toast.nudge { animation: nudge 340ms var(--ease); }
  @keyframes nudge {
    0%, 100% { translate: 0 0; }
    20% { translate: -4px 0; }
    45% { translate: 3px 0; }
    70% { translate: -2px 0; }
  }

  .badge {
    position: relative;
    flex: none;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    box-shadow: 0 3px 10px rgba(47, 123, 255, 0.4);
  }
  .badge svg { width: 14px; height: 14px; }
  .badge::after {
    content: "";
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    border: 1.5px solid rgba(47, 123, 255, 0.5);
    animation: pulse 2s ease-out infinite;
  }
  @keyframes pulse {
    from { transform: scale(0.9); opacity: 0.85; }
    to { transform: scale(1.3); opacity: 0; }
  }

  .title {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.1px;
    white-space: nowrap;
  }
  .live {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #3ddc97;
    animation: live 1.6s ease-out infinite;
  }
  @keyframes live {
    0% { box-shadow: 0 0 0 0 rgba(61, 220, 151, 0.6); }
    100% { box-shadow: 0 0 0 5px rgba(61, 220, 151, 0); }
  }

  .divider {
    flex: none;
    width: 1px;
    height: 16px;
    margin-left: 2px;
    background: var(--border);
  }

  .stop {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 12px 0 10px;
    border-radius: 999px;
    border: 1px solid transparent;
    background: rgba(255, 255, 255, 0.06);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 160ms ease, border-color 160ms ease, transform 120ms ease;
  }
  .stop:hover { background: rgba(255, 93, 93, 0.16); border-color: rgba(255, 93, 93, 0.45); }
  .stop:active { transform: scale(0.96); }
  .stop:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .stop:disabled { opacity: 0.6; cursor: default; }
  .stop .square { width: 8px; height: 8px; border-radius: 2px; background: var(--danger); }

  @media (max-width: 360px) {
    .divider { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .ripple, .badge::after, .live, .toast.nudge { animation: none; }
    .toast { transition: opacity 120ms linear; }
  }
</style>
</head>
<body>
  <div class="toast" id="toast" role="status" aria-live="polite">
    <div class="badge" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 3.5l1.8 4.9 4.9 1.8-4.9 1.8L11 16.9l-1.8-4.9-4.9-1.8 4.9-1.8L11 3.5z" />
        <path d="M18.5 14.5l.75 2 2 .75-2 .75-.75 2-.75-2-2-.75 2-.75.75-2z" />
      </svg>
    </div>
    <div class="title"><span class="live" aria-hidden="true"></span>Agent mode is active</div>
    <span class="sr-only">Controls are disabled while the agent works on this page.</span>
    <span class="divider" aria-hidden="true"></span>
    <button class="stop" id="stop" type="button">
      <span class="square" aria-hidden="true"></span><span id="stop-label">Stop</span>
    </button>
  </div>
<script>
  (function () {
    var toast = document.getElementById('toast');
    var stop = document.getElementById('stop');
    var stopLabel = document.getElementById('stop-label');
    var hideTimer = 0;
    var lastWheel = 0;
    var MODIFIERS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'];

    function scheduleHide(ms) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { toast.classList.remove('visible', 'nudge'); }, ms);
    }

    function show() {
      if (toast.classList.contains('visible')) {
        toast.classList.remove('nudge');
        void toast.offsetWidth;
        toast.classList.add('nudge');
      } else {
        toast.classList.add('visible');
      }
      scheduleHide(3200);
    }

    function ripple(x, y) {
      var ring = document.createElement('div');
      ring.className = 'ripple';
      ring.style.left = x + 'px';
      ring.style.top = y + 'px';
      document.body.appendChild(ring);
      setTimeout(function () { ring.remove(); }, 700);
    }

    function onToast(event) { return toast.contains(event.target); }

    window.addEventListener('pointerdown', function (event) {
      if (onToast(event)) return;
      event.preventDefault();
      ripple(event.clientX, event.clientY);
      show();
    }, true);

    window.addEventListener('wheel', function (event) {
      event.preventDefault();
      var now = Date.now();
      if (now - lastWheel > 450) { lastWheel = now; show(); }
    }, { passive: false, capture: true });

    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { scheduleHide(0); return; }
      if (MODIFIERS.indexOf(event.key) !== -1) return;
      if (event.target === stop && (event.key === 'Enter' || event.key === ' ')) return;
      event.preventDefault();
      show();
    }, true);

    window.addEventListener('contextmenu', function (event) { event.preventDefault(); }, true);
    window.addEventListener('dragstart', function (event) { event.preventDefault(); }, true);

    toast.addEventListener('pointerenter', function () { clearTimeout(hideTimer); });
    toast.addEventListener('pointerleave', function () { scheduleHide(1800); });

    stop.addEventListener('click', function () {
      if (stop.disabled) return;
      stop.disabled = true;
      stopLabel.textContent = 'Stopping…';
      window.location.assign(${JSON.stringify(STOP_URL)});
    });
  })();
</script>
</body>
</html>`

const SHIELD_URL = `data:text/html;charset=utf-8,${encodeURIComponent(SHIELD_HTML)}`

type ShieldEntry = {
  view: WebContentsView
  window: BrowserWindow
  /** Detaches the listener that drops the shield when its tab is destroyed. */
  release: () => void
}

export class AgentInputShield {
  private readonly shields = new Map<number, ShieldEntry>()

  constructor(private readonly onStopRequested: (tabId: number) => void) {}

  isLocked(tabId: number): boolean {
    return this.shields.has(tabId)
  }

  /** Locks a tab: stacks the shield above it and moves keyboard focus off the page. */
  lock(tabId: number, tab: WebContentsView, window: BrowserWindow): void {
    const existing = this.shields.get(tabId)
    if (existing) {
      existing.view.setBounds(tab.getBounds())
      return
    }

    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: false,
      },
    })
    view.setBackgroundColor('#00000000')

    const contents = view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (url === STOP_URL) this.onStopRequested(tabId)
    })
    contents.on('will-redirect', (event) => event.preventDefault())

    // Appended last, so it is the top-most view and receives every real
    // input event over the tab's rect.
    window.contentView.addChildView(view)
    view.setBounds(tab.getBounds())
    contents.loadURL(SHIELD_URL).catch((error) => {
      console.warn('[agent-shield] Shield page failed to load:', error)
    })

    // A page that already had keyboard focus would keep receiving keystrokes
    // under the shield, so focus moves onto the shield itself.
    if (!tab.webContents.isDestroyed() && tab.webContents.isFocused()) contents.focus()

    const onTabDestroyed = () => this.unlock(tabId)
    tab.webContents.once('destroyed', onTabDestroyed)
    this.shields.set(tabId, {
      view,
      window,
      release: () => {
        if (!tab.webContents.isDestroyed()) tab.webContents.removeListener('destroyed', onTabDestroyed)
      },
    })
  }

  unlock(tabId: number): void {
    const entry = this.shields.get(tabId)
    if (!entry) return
    this.shields.delete(tabId)
    entry.release()

    const { view, window } = entry
    const hadFocus = !view.webContents.isDestroyed() && view.webContents.isFocused()
    if (!window.isDestroyed()) {
      window.contentView.removeChildView(view)
      if (hadFocus) window.webContents.focus()
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  /** Keeps a shield glued to its tab as the tab is resized, shown, or hidden. */
  syncBounds(tabId: number, bounds: Rectangle): void {
    this.shields.get(tabId)?.view.setBounds(bounds)
  }

  /** Drops every shield — used when the shell reloads or crashes and can no longer unlock them. */
  unlockAll(): void {
    for (const tabId of [...this.shields.keys()]) this.unlock(tabId)
  }
}
