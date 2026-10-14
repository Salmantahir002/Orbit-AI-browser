import { app, BrowserWindow, Menu, clipboard, dialog, shell, type MenuItemConstructorOptions, type WebContents } from 'electron'
import os from 'node:os'

const MAX_SEARCH_LABEL_LENGTH = 32
const BACKEND_HEALTH_URL = 'http://127.0.0.1:8000/api/v1/health'
const BACKEND_FETCH_TIMEOUT_MS = 1500

type BackendRuntimeInfo = {
  node: string
  node_implementation: string
  fastify: string
  platform: string
}

// The Fastify process doesn't restart when a webview is inspected, so its
// version info is fetched once per app session rather than on every open.
let backendRuntimeInfo: Promise<BackendRuntimeInfo | null> | null = null

function fetchBackendRuntimeInfo(): Promise<BackendRuntimeInfo | null> {
  if (!backendRuntimeInfo) {
    backendRuntimeInfo = (async () => {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), BACKEND_FETCH_TIMEOUT_MS)
        const response = await fetch(BACKEND_HEALTH_URL, { signal: controller.signal })
        clearTimeout(timeout)
        if (!response.ok) return null
        const body = await response.json()
        return (body?.runtime ?? null) as BackendRuntimeInfo | null
      } catch {
        return null
      }
    })()
  }
  return backendRuntimeInfo
}

function truncate(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ')
  return collapsed.length > MAX_SEARCH_LABEL_LENGTH ? `${collapsed.slice(0, MAX_SEARCH_LABEL_LENGTH)}…` : collapsed
}

/** Opens a plain, preload-free window — the guest page never needs Node or app IPC access. */
function openInNewWindow(url: string) {
  const child = new BrowserWindow({ width: 1280, height: 800, webPreferences: { contextIsolation: true } })
  child.loadURL(url).catch((error) => console.warn('[webview-context-menu] Failed to open new window:', error))
}

function openViewSource(guestContents: WebContents) {
  openInNewWindow(`view-source:${guestContents.getURL()}`)
}

/**
 * DevToolsAPI.showPanel is the same undocumented-but-stable hook Chromium's own
 * DevTools front-end uses internally; it is the only way to land on a specific
 * panel programmatically since Electron exposes no public "open to console" API.
 */
function openDevToolsPanel(guestContents: WebContents, panel: 'elements' | 'console') {
  const showPanel = () => {
    guestContents.devToolsWebContents
      ?.executeJavaScript(`DevToolsAPI.showPanel('${panel}')`)
      .catch(() => undefined)
  }

  if (guestContents.isDevToolsOpened()) {
    showPanel()
  } else {
    guestContents.once('devtools-opened', showPanel)
    guestContents.openDevTools({ mode: 'detach' })
  }
}

/**
 * Prints a Chrome-style version banner into the *page's* console (not the
 * DevTools frontend's own console) so anyone opening DevTools on a guest
 * webview immediately sees what runtime they're actually debugging against.
 */
async function logVersionBanner(guestContents: WebContents) {
  const backend = await fetchBackendRuntimeInfo()

  const versions: Record<string, string> = {
    'PromptGuard': app.getVersion(),
    Electron: process.versions.electron ?? 'unknown',
    Chromium: process.versions.chrome ?? 'unknown',
    'Node.js': process.versions.node ?? 'unknown',
    V8: process.versions.v8 ?? 'unknown',
    OS: `${os.type()} ${os.release()} (${process.arch})`,
    Page: guestContents.getURL(),
    ...(backend
      ? {
          'Node.js (backend)': backend.node_implementation,
          Fastify: backend.fastify,
          'Backend OS': backend.platform,
        }
      : { Backend: 'unreachable (is the Node backend running?)' }),
  }

  const script = `
    console.log('%cPromptGuard runtime', 'font-weight:bold;font-size:12px;color:#4f9dff;');
    console.table(${JSON.stringify(versions)});
  `

  // The DevTools front end wires up its Runtime listener asynchronously right
  // after `devtools-opened` fires; calling in the same tick can race that and
  // silently miss the message, so give it a beat before evaluating.
  setTimeout(() => {
    guestContents.executeJavaScript(script).catch((error) => {
      console.warn('[webview-context-menu] Failed to log version banner:', error)
    })
  }, 300)
}

async function savePageAs(guestContents: WebContents, mainWindow: BrowserWindow) {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: (guestContents.getTitle() || 'page').replace(/[\\/:*?"<>|]/g, '_'),
    filters: [{ name: 'Webpage, Complete', extensions: ['html'] }],
  })
  if (canceled || !filePath) return

  try {
    await guestContents.savePage(filePath, 'HTMLComplete')
  } catch (error) {
    console.warn('[webview-context-menu] savePage failed:', error)
  }
}

/**
 * Builds a Chrome-equivalent right-click menu for a guest tab's content.
 * A `WebContentsView` gets no native context menu on its own — this is the
 * one gateway that supplies it, wired per-guest when the tab is created.
 */
export function attachWebviewContextMenu(guestContents: WebContents, mainWindow: BrowserWindow, saveDownloadAs = (url: string) => guestContents.downloadURL(url)) {
  // Fires on every open, not just the first — a fresh navigation deserves a
  // fresh banner since "Page" in the table would otherwise go stale.
  guestContents.on('devtools-opened', () => logVersionBanner(guestContents))

  guestContents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = []

    if (params.linkURL) {
      template.push(
        { label: 'Open Link in New Window', click: () => openInNewWindow(params.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { label: 'Save Link As...', click: () => saveDownloadAs(params.linkURL) },
        { type: 'separator' },
      )
    }

    if (params.hasImageContents) {
      template.push(
        { label: 'Save Image As...', click: () => saveDownloadAs(params.srcURL) },
        { label: 'Copy Image', click: () => guestContents.copyImageAt(params.x, params.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' },
      )
    }

    if (params.isEditable) {
      template.push(
        { label: 'Undo', enabled: params.editFlags.canUndo, click: () => guestContents.undo() },
        { label: 'Redo', enabled: params.editFlags.canRedo, click: () => guestContents.redo() },
        { type: 'separator' },
        { label: 'Cut', enabled: params.editFlags.canCut, click: () => guestContents.cut() },
        { label: 'Copy', enabled: params.editFlags.canCopy, click: () => guestContents.copy() },
        { label: 'Paste', enabled: params.editFlags.canPaste, click: () => guestContents.paste() },
        { label: 'Select All', enabled: params.editFlags.canSelectAll, click: () => guestContents.selectAll() },
        { type: 'separator' },
      )
    } else if (params.selectionText) {
      const query = encodeURIComponent(params.selectionText)
      template.push(
        { label: 'Copy', click: () => clipboard.writeText(params.selectionText) },
        { label: `Search Google for "${truncate(params.selectionText)}"`, click: () => shell.openExternal(`https://www.google.com/search?q=${query}`) },
        { type: 'separator' },
      )
    }

    template.push(
      { label: 'Back', enabled: guestContents.navigationHistory.canGoBack(), click: () => guestContents.navigationHistory.goBack() },
      { label: 'Forward', enabled: guestContents.navigationHistory.canGoForward(), click: () => guestContents.navigationHistory.goForward() },
      { label: 'Reload', click: () => guestContents.reload() },
      { type: 'separator' },
      { label: 'Save As...', click: () => void savePageAs(guestContents, mainWindow) },
      { label: 'Print...', click: () => guestContents.print() },
      { type: 'separator' },
      { label: 'View Page Source', click: () => openViewSource(guestContents) },
      { label: 'Inspect', click: () => guestContents.inspectElement(params.x, params.y) },
      { label: 'Console', click: () => openDevToolsPanel(guestContents, 'console') },
    )

    Menu.buildFromTemplate(template).popup({ window: mainWindow })
  })
}
