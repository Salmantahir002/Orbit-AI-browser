import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'

type FullscreenTab = {
  view: WebContentsView
  window: BrowserWindow
  /** Where the tab goes back to: the last bounds the shell asked for. */
  restore: Rectangle
  fit: () => void
  windowLeft: () => void
}

/**
 * Page fullscreen (a video's full-screen button, `element.requestFullscreen()`)
 * as Chrome does it: the tab covers the whole screen, toolbar and all.
 *
 * Electron already takes the window fullscreen when a tab's page asks, but a
 * tab is a WebContentsView the shell positions under its toolbar, and Electron
 * leaves its bounds alone. The page then lays out its fullscreen element for
 * the screen inside a view still the size of the tab, and the video shows
 * cropped beneath the toolbar. So while a page is fullscreen its view is
 * stretched over the whole window, and the shell's own bounds updates for it
 * are held back until it leaves.
 *
 * Leaving the window's fullscreen (F11, the menu) does not end the page's in
 * Chromium, nor does hiding its tab, so both end it here, as in Chrome. Esc
 * and the page's own exit button end it in Chromium.
 */
export class PageFullscreen {
  private readonly tabs = new Map<number, FullscreenTab>()

  constructor(private readonly syncBounds: (webContentsId: number, bounds: Rectangle) => void) {}

  /** Wires a tab's view; call once per guest view. */
  attach(view: WebContentsView, window: BrowserWindow) {
    const contents = view.webContents
    const id = contents.id
    contents.on('enter-html-full-screen', () => this.enter(id, view, window))
    contents.on('leave-html-full-screen', () => this.leave(id))
    contents.once('destroyed', () => this.leave(id))
  }

  /**
   * The shell's bounds for a tab. False if the tab is fullscreen: the bounds
   * are kept for its return instead of applied, and a tab the shell hides
   * (another tab selected) leaves fullscreen.
   */
  setBounds(webContentsId: number, bounds: Rectangle): boolean {
    const tab = this.tabs.get(webContentsId)
    if (!tab) return true
    tab.restore = bounds
    if (bounds.width === 0 || bounds.height === 0) this.exit(tab)
    return false
  }

  private enter(id: number, view: WebContentsView, window: BrowserWindow) {
    if (this.tabs.has(id) || window.isDestroyed()) return
    const fit = () => {
      if (window.isDestroyed() || view.webContents.isDestroyed()) return
      const [width, height] = window.getContentSize()
      view.setBounds({ x: 0, y: 0, width, height })
      this.syncBounds(id, view.getBounds())
    }
    const tab: FullscreenTab = { view, window, restore: view.getBounds(), fit, windowLeft: () => this.exit(tab) }
    this.tabs.set(id, tab)
    // The window grows into fullscreen in steps, and the last (the hidden
    // menu bar giving back its strip) fires no 'resize': follow the content
    // area itself.
    window.contentView.on('bounds-changed', fit)
    window.on('leave-full-screen', tab.windowLeft)
    fit()
  }

  private leave(id: number) {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.tabs.delete(id)
    if (!tab.window.isDestroyed()) tab.window.contentView.removeListener('bounds-changed', tab.fit)
    tab.window.removeListener('leave-full-screen', tab.windowLeft)
    if (tab.view.webContents.isDestroyed()) return
    tab.view.setBounds(tab.restore)
    this.syncBounds(id, tab.view.getBounds())
  }

  /** Ends the page's fullscreen; Chromium then reports the leave. */
  private exit(tab: FullscreenTab) {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    // Electron has no API to end a page's fullscreen from outside the page.
    contents.executeJavaScript('document.fullscreenElement ? document.exitFullscreen() : undefined').catch(() => undefined)
  }
}
