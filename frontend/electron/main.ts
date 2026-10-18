import { app, BrowserWindow, dialog, ipcMain, session, WebContentsView } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, NativeImage, WebContents } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyElectronSecurityConfig } from './electronSecurityConfig.js'
import { attachWebviewContextMenu } from './webviewContextMenu.js'
import { AgentInputShield } from './agentInputShield.js'
import { startBackend, stopBackend } from './backendProcess.js'
import { CdpInspectionService } from './cdpInspectionService.js'
import {
  BrowserRuntime,
  CdpSessionRegistry,
  RUNTIME_INVOKE_CHANNEL,
  parseRuntimeRequest,
  type RuntimeResult,
} from './browserRuntime/index.js'

import { providerSecureStore, type ProviderSaveRequest } from './providerSecureStore.js'
import { BrowserUIController } from './browserUIController.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const isDevelopment = process.env.PROMPT_DEFENSE_DEV === 'true'

if (isDevelopment) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
}

app.setPath('userData', process.env.ORBIT_USER_DATA_DIR || path.join(app.getPath('appData'), 'prompt-defense-browser'))
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
app.commandLine.appendSwitch('disk-cache-size', '0')

const browserWindows = new Map<number, BrowserWindow>()
const tabOwners = new Map<number, BrowserWindow>()
let browserUI: BrowserUIController
const cdpSessionRegistry = new CdpSessionRegistry()
const cdpInspectionService = new CdpInspectionService()
// The runtime borrows the CDP collector as a sensor, but the agent's scan
// travels its own IPC channel, its own backend endpoint, and its own event log.
const browserRuntime = new BrowserRuntime({
  deepContentProvider: (targetId) => cdpInspectionService.capture(targetId),
  // The agent can ask for an upload, but only the user can say which file.
  // A cancelled dialog is a refusal, and the planner never sees a path.
  filePickerProvider: async () => {
    const mainWindow = BrowserWindow.getFocusedWindow() ?? browserWindows.values().next().value
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose files for the agent to upload',
      message: 'The AI agent has requested to attach files to this page.',
      properties: ['openFile', 'multiSelections'],
    })

    return result.canceled ? [] : result.filePaths
  },
  // The one exception: a file this browser downloaded earlier in the session
  // (the Downloads panel), offered to the planner by id only. The approval
  // policy still names the file to the user before it is attached.
  downloadsProvider: () => browserUI.sessionDownloads().map((entry) => ({
    filename: entry.filename,
    sizeBytes: entry.receivedBytes || entry.totalBytes,
    path: entry.savePath,
  })),
})

// Guest pages are hosted as main-owned WebContentsViews, keyed by their own
// webContents id (the same id every other channel — CDP, the scan IPC, the
// runtime IPC — already addresses a tab by). The renderer never holds a
// reference to the guest content itself, only this id.
const tabViews = new Map<number, WebContentsView>()

// Blocks the user's own input on a tab while the agent drives it. Stop in the
// shield's toast is forwarded to the renderer, which owns the running task.
const agentInputShield = new AgentInputShield((tabId) => {
  const mainWindow = tabOwners.get(tabId)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent:stop-requested', tabId)
})

function requireShell(event: IpcMainInvokeEvent | IpcMainEvent): BrowserWindow | null {
  const frame = event.senderFrame
  if (!frame || frame.routingId !== event.sender.mainFrame.routingId || frame.processId !== event.sender.mainFrame.processId) return null
  return browserWindows.get(event.sender.id) ?? null
}

function requireTabView(event: IpcMainInvokeEvent | IpcMainEvent, webContentsId: unknown): WebContentsView | null {
  const mainWindow = requireShell(event)
  if (!mainWindow || !Number.isInteger(webContentsId) || tabOwners.get(webContentsId as number) !== mainWindow) {
    return null
  }
  return tabViews.get(webContentsId as number) ?? null
}

function sendTabEvent(webContentsId: number, payload: Record<string, unknown>) {
  const mainWindow = tabOwners.get(webContentsId)
  mainWindow?.webContents.send('browser:tab-event', { webContentsId, ...payload })
}

/** Wires a freshly created guest view into the same sensors a `<webview>` used to attach on `did-attach-webview`. */
function attachGuestBehaviour(view: WebContentsView, mainWindow: BrowserWindow) {
  const contents = view.webContents
  browserUI.attachShortcuts(contents, mainWindow)
  browserUI.initializePageZoom(contents)
  let lastVisitId: string | null = null
  let lastVisitUrl: string | null = null
  const recordVisit = (url: string) => { lastVisitId = browserUI.profile.recordVisit(url, contents.getTitle()); lastVisitUrl = url }
  contents.on('did-navigate', (_event, url) => { browserUI.applyPageZoom(contents); recordVisit(url) })
  // SPAs (GitHub, YouTube, …) call history.replaceState/pushState repeatedly while loading,
  // each firing did-navigate-in-page with the same URL; only a changed URL is a new visit.
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame && url !== lastVisitUrl) recordVisit(url) })
  contents.on('page-title-updated', (_event, title) => browserUI.profile.updateVisit(lastVisitId, title))
  contents.setWindowOpenHandler(({ url, disposition, referrer, postBody }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { action: 'deny' }
    const hostWindow = mainWindow
    return {
      action: 'allow',
      outlivesOpener: true,
      overrideBrowserWindowOptions: {
        webPreferences: {
          session: contents.session,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webviewTag: false,
        },
      },
      createWindow: (options) => {
        // Electron may create the child WebContents before calling us. Its identity
        // must be preserved or window.open throws "Invalid webContents".
        const suppliedContents = (options as typeof options & { webContents?: WebContents }).webContents
        const popupView = new WebContentsView({
          webContents: suppliedContents,
          webPreferences: options.webPreferences,
        })
        hostWindow.contentView.addChildView(popupView)
        popupView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
        const popupId = popupView.webContents.id
        tabViews.set(popupId, popupView)
        tabOwners.set(popupId, hostWindow)
        attachGuestBehaviour(popupView, hostWindow)
        browserUI.raise(hostWindow)
        popupView.webContents.once('destroyed', () => {
          if (!tabViews.delete(popupId)) return
          tabOwners.delete(popupId)
          if (!hostWindow.isDestroyed()) {
            hostWindow.contentView.removeChildView(popupView)
            hostWindow.webContents.send('browser:popup-closed', popupId)
          }
        })
        hostWindow.webContents.send('browser:popup-tab', { webContentsId: popupId, url, disposition })
        if (!suppliedContents) {
          const contentType = postBody?.boundary
            ? `${postBody.contentType}; boundary=${postBody.boundary}`
            : postBody?.contentType
          popupView.webContents.loadURL(url, {
            httpReferrer: referrer,
            ...(postBody && { postData: postBody.data, extraHeaders: `content-type: ${contentType}` }),
          }).catch((error) => console.warn('[main] Popup tab loadURL failed:', error))
        }
        return popupView.webContents
      },
    }
  })
  // Electron's guest content has no native context menu of its own; this is
  // what supplies the Chrome-equivalent Back/Reload/Inspect/Console menu.
  attachWebviewContextMenu(contents, mainWindow, (url) => browserUI.requestSaveAs(contents, url))

  // One CDP session per guest, shared by the manual scanner and the agent
  // runtime. Electron permits only a single debugger attachment per
  // webContents, so neither consumer may attach on its own.
  const cdpSession = cdpSessionRegistry.attach(contents)
  if (cdpSession) {
    cdpInspectionService.watch(cdpSession)
    browserRuntime.registerTarget(cdpSession)
    contents.once('destroyed', () => {
      cdpInspectionService.forget(cdpSession.targetId)
      browserRuntime.unregisterTarget(cdpSession.targetId)
    })
  }

  const id = contents.id
  contents.on('did-start-loading', () => sendTabEvent(id, { type: 'did-start-loading' }))
  contents.on('did-stop-loading', () => sendTabEvent(id, { type: 'did-stop-loading' }))
  contents.on('did-finish-load', () => sendTabEvent(id, { type: 'did-finish-load' }))
  contents.on('did-navigate', (_event, url) => sendTabEvent(id, { type: 'did-navigate', url }))
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) sendTabEvent(id, { type: 'did-navigate-in-page', url }) })
  contents.on('page-favicon-updated', (_event, favicons) => {
    if (favicons && favicons.length > 0) {
      sendTabEvent(id, { type: 'page-favicon-updated', favicon: favicons[0] })
    }
  })
  contents.on('page-title-updated', (_event, title) => {
    sendTabEvent(id, { type: 'page-title-updated', title })
  })
  contents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (errorCode === -3) return // aborted by a subsequent navigation, not a real failure
    sendTabEvent(id, { type: 'did-fail-load', errorCode, errorDescription })
  })
}

async function createWindow(startInBrowser = false) {
  const mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#050706',
    title: 'Orbit',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
    },
  })
  const shellId = mainWindow.webContents.id
  browserWindows.set(shellId, mainWindow)
  applyElectronSecurityConfig(session.defaultSession, mainWindow, isDevelopment)
  const releaseTabs = () => {
    for (const [id, owner] of tabOwners) {
      if (owner !== mainWindow) continue
      agentInputShield.unlock(id)
      const view = tabViews.get(id)
      tabViews.delete(id)
      tabOwners.delete(id)
      if (view) {
        if (!mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view)
        if (!view.webContents.isDestroyed()) view.webContents.close()
      }
    }
  }
  // A reloaded or crashed shell has lost the task that would unlock its tabs.
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) releaseTabs()
  })
  mainWindow.webContents.on('render-process-gone', releaseTabs)
  mainWindow.on('closed', () => { releaseTabs(); browserWindows.delete(shellId) })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    console.error(`[renderer-load-failed] ${errorCode} ${errorDescription} ${validatedUrl}`)
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // Start the shell first; registering the overlay synchronously before this promise settles
  // makes its IPC available to React, while its renderer loads after the welcome frame.
  const shellLoaded = (isDevelopment
    ? mainWindow.loadURL(`http://localhost:5173${startInBrowser ? '?start=browser' : ''}`)
    : mainWindow.loadFile(path.join(__dirname, '../dist/index.html'), { query: startInBrowser ? { start: 'browser' } : {} }))
    .catch((err) => console.error(`[electron-main] Shell load failed: ${err}`))
  await browserUI.attach(mainWindow, shellLoaded)
}

ipcMain.handle('security:scan-webview', (event, webContentsId: unknown) => {
  if (!requireTabView(event, webContentsId)) {
    return null
  }

  return cdpInspectionService.capture(webContentsId as number)
})

// Browser tab hosting: the renderer owns tab UI/state, main owns the actual
// guest content as a WebContentsView positioned over an empty React container.
ipcMain.handle('browser:create-tab', (event, url: unknown) => {
  const mainWindow = requireShell(event)
  if (!mainWindow || typeof url !== 'string') {
    return null
  }

  const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } })
  mainWindow.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 }) // invisible until the renderer reports real bounds
  const viewId = view.webContents.id
  tabViews.set(viewId, view)
  tabOwners.set(viewId, mainWindow)
  attachGuestBehaviour(view, mainWindow)
  browserUI.raise(mainWindow)
  view.webContents.loadURL(url).catch((err) => {
    // close-tab drops the view from tabViews first, so a tab closed before its first load settled
    // is an aborted load, not a failure.
    if (!tabViews.has(viewId)) return
    console.warn('[main] Initial tab loadURL failed:', err)
  })

  return { webContentsId: viewId, zoom: browserUI.getPageZoom(view.webContents) }
})

ipcMain.handle('browser:close-tab', (event, webContentsId: unknown) => {
  const mainWindow = requireShell(event)
  const view = requireTabView(event, webContentsId)
  if (!view || !mainWindow) return
  agentInputShield.unlock(webContentsId as number)
  mainWindow.contentView.removeChildView(view)
  tabViews.delete(webContentsId as number)
  tabOwners.delete(webContentsId as number)
  if (!view.webContents.isDestroyed()) view.webContents.close()
})

ipcMain.handle('browser:get-tab-info', (event, webContentsId: unknown) => {
  const view = requireTabView(event, webContentsId)
  if (!view || view.webContents.isDestroyed()) return null
  return { url: view.webContents.getURL(), title: view.webContents.getTitle() }
})

// The assistant panel is glass, but a guest page is a native view the panel's
// CSS cannot see through. It asks for a tiny frame of the page beside it (or,
// on the home page, of the shell's own page area) and paints that, blurred,
// behind its glass. Only the half next to the panel is taken; it is shrunk to
// a few dozen pixels here, so no readable page content ever leaves main. The
// luminance lets the panel darken its tint over bright pages to keep its own
// text legible.
const BACKDROP_WIDTH = 48

function isRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  const rect = value as { x: number; y: number; width: number; height: number } | null
  return Boolean(rect) && [rect!.x, rect!.y, rect!.width, rect!.height].every(Number.isFinite)
}

ipcMain.handle('browser:capture-backdrop', async (event, webContentsId: unknown, region: unknown) => {
  const mainWindow = requireShell(event)
  if (!mainWindow) return null
  let frame: NativeImage
  try {
    if (webContentsId !== null) {
      const view = requireTabView(event, webContentsId)
      if (!view || view.webContents.isDestroyed()) return null
      const { width, height } = view.getBounds()
      // Zero bounds: the guest is hidden (a modal, a drag-resize). Keep the old frame.
      if (width < 2 || height < 2) return null
      frame = await view.webContents.capturePage({ x: Math.floor(width / 2), y: 0, width: Math.ceil(width / 2), height })
    } else {
      if (!isRect(region) || region.width < 2 || region.height < 2) return null
      frame = await mainWindow.webContents.capturePage({
        x: Math.round(region.x + region.width / 2),
        y: Math.round(region.y),
        width: Math.round(region.width / 2),
        height: Math.round(region.height),
      })
    }
  } catch {
    return null
  }
  if (frame.isEmpty()) return null

  const small = frame.resize({ width: BACKDROP_WIDTH, quality: 'good' })
  return { image: `data:image/jpeg;base64,${small.toJPEG(70).toString('base64')}`, luminance: meanLuminance(small) }
})

/** Mean luminance of an image, 0 (black) to 1 (white). Sample small images only. */
function meanLuminance(image: NativeImage): number {
  const bitmap = image.toBitmap() // BGRA
  let sum = 0
  for (let i = 0; i < bitmap.length; i += 4) sum += 0.0722 * bitmap[i] + 0.7152 * bitmap[i + 1] + 0.2126 * bitmap[i + 2]
  return bitmap.length ? sum / (bitmap.length / 4) / 255 : 0
}

// The report drawers are glass too, but while one is open the guest view is
// hidden (it would cover the drawer). Just before it hides, the shell asks for
// one frame of the whole page and shows it in the guest's place, so the drawer
// slides in over the page itself. The frame is scaled to the view's CSS size
// and never leaves this window. The luminance is of the strip the drawer
// covers, for the drawer's tint to darken over bright pages.
const DRAWER_STRIP_WIDTH = 540

ipcMain.handle('browser:capture-frame', async (event, webContentsId: unknown) => {
  const view = requireTabView(event, webContentsId)
  if (!view || view.webContents.isDestroyed()) return null
  const { width, height } = view.getBounds()
  // Zero bounds: the guest is already hidden, so there is nothing on screen to freeze.
  if (width < 2 || height < 2) return null
  let frame: NativeImage
  try {
    frame = await view.webContents.capturePage()
  } catch {
    return null
  }
  if (frame.isEmpty()) return null

  const sized = frame.resize({ width, height, quality: 'good' })
  const stripWidth = Math.min(DRAWER_STRIP_WIDTH, width)
  const strip = sized.crop({ x: width - stripWidth, y: 0, width: stripWidth, height }).resize({ width: BACKDROP_WIDTH, quality: 'good' })
  return { image: `data:image/jpeg;base64,${sized.toJPEG(82).toString('base64')}`, luminance: meanLuminance(strip) }
})

ipcMain.handle('browser:navigate', async (event, webContentsId: unknown, url: unknown) => {
  const view = requireTabView(event, webContentsId)
  if (!view || typeof url !== 'string') return
  // Awaited (unlike the fire-and-forget channels below): the old <webview>.loadURL()
  // resolved only once the navigation landed, and callers — notably the e2e
  // suite's same-URL reloads — depend on that to know the page actually reset.
  try {
    await view.webContents.loadURL(url)
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ERR_ABORTED') console.error('[main] Tab loadURL failed:', err)
  }
})

ipcMain.handle('browser:go-back', (event, webContentsId: unknown) => {
  const view = requireTabView(event, webContentsId)
  if (view?.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack()
})

ipcMain.handle('browser:go-forward', (event, webContentsId: unknown) => {
  const view = requireTabView(event, webContentsId)
  if (view?.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward()
})

ipcMain.handle('browser:reload', (event, webContentsId: unknown) => {
  requireTabView(event, webContentsId)?.webContents.reload()
})

ipcMain.handle('browser:stop', (event, webContentsId: unknown) => {
  requireTabView(event, webContentsId)?.webContents.stop()
})

ipcMain.on('browser:set-active-tab', (event, webContentsId: unknown) => {
  if (requireTabView(event, webContentsId)) browserUI.setActiveTarget(requireShell(event)!, webContentsId as number)
})


// setBounds fires on every resize/tab-switch — a fire-and-forget `send`
// avoids an IPC round trip on that hot path.
ipcMain.on('browser:set-bounds', (event, webContentsId: unknown, bounds: unknown) => {
  const view = requireTabView(event, webContentsId)
  const rect = bounds as { x: number; y: number; width: number; height: number } | null
  if (!view || !rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return
  view.setBounds({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  })
  agentInputShield.syncBounds(webContentsId as number, view.getBounds())
  if (rect.width > 0 && rect.height > 0) browserUI.setActiveTarget(requireShell(event)!, webContentsId as number)
})

// Agent mode locks the tab it drives against the user's own mouse and keyboard
// for the duration of a task (see agentInputShield.ts).
ipcMain.handle('browser:set-agent-lock', async (event, webContentsId: unknown, locked: unknown) => {
  const mainWindow = requireShell(event)
  const view = requireTabView(event, webContentsId)
  if (!view || !mainWindow || typeof locked !== 'boolean') return false
  if (locked) agentInputShield.lock(webContentsId as number, view, mainWindow)
  else agentInputShield.unlock(webContentsId as number)
  browserUI.raise(mainWindow)
  // The same span the user is locked out is the span the agent owns the
  // page's file choosers: an "Attach" click must not open an OS dialog the
  // agent cannot operate. Failure only means the dialog may appear.
  await browserRuntime.interceptFileChoosers(webContentsId as number, locked).catch((error) => {
    console.warn(`[browser-runtime] File chooser interception ${locked ? 'on' : 'off'} failed:`, error)
  })
  return true
})

// Sole entry point for agent-driven browser actions. The manual scan channel
// above is deliberately separate and is never used by the agent runtime.
ipcMain.handle(RUNTIME_INVOKE_CHANNEL, (event, payload: unknown): Promise<RuntimeResult<unknown>> | RuntimeResult<unknown> => {
  if (!requireShell(event)) {
    return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Runtime commands may only originate from the app shell' } }
  }

  const request = parseRuntimeRequest(payload)
  if (!request) {
    return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Malformed browser runtime request' } }
  }

  if (!requireTabView(event, request.targetId)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'This target belongs to another browser window' } }

  return browserRuntime.invoke(request.targetId, request.name, request.params as never)
})

// LLM Provider Credentials & Configuration IPC
ipcMain.handle('providers:get-all', () => {
  return providerSecureStore.getAllProviders()
})

ipcMain.handle('providers:save', async (_event, payload: ProviderSaveRequest) => {
  const result = providerSecureStore.saveProvider(payload)
  if (payload.set_active) {
    await providerSecureStore.syncWithBackend()
  }
  return result
})

ipcMain.handle('providers:delete', async (_event, providerId: string) => {
  const success = providerSecureStore.deleteProvider(providerId)
  await providerSecureStore.syncWithBackend()
  return { ok: success }
})

ipcMain.handle('providers:set-active', async (_event, payload: { id: string | null; selected_model?: string }) => {
  providerSecureStore.setActiveProvider(payload.id, payload.selected_model)
  await providerSecureStore.syncWithBackend()
  return { ok: true }
})

ipcMain.handle('providers:get-active', () => {
  const all = providerSecureStore.getAllProviders()
  return all.find((p) => p.is_active) || null
})

app.whenReady().then(async () => {
  browserUI = new BrowserUIController({
    createWindow: () => createWindow(true),
    getTarget: (window, id) => tabOwners.get(id) === window ? tabViews.get(id) ?? null : null,
    loadOverlay: async (contents) => {
      if (isDevelopment) await contents.loadURL('http://localhost:5173?surface=browser-overlay')
      else await contents.loadFile(path.join(__dirname, '../dist/index.html'), { query: { surface: 'browser-overlay' } })
    },
  })
  // Packaged / e2e runs have no concurrently wrapper — bring the backend up here. The window
  // does not wait for it: nothing on the welcome screen needs the backend, and every
  // backend-dependent action already fails closed with a "not reachable" error until it is up.
  const backendReady = startBackend()

  await createWindow()

  // Push the saved active provider to the backend as soon as it answers /health.
  backendReady
    .then(() => providerSecureStore.syncWithBackend())
    .catch((err) => {
      console.warn('[main] Initial provider backend sync failed:', err)
    })

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow()
    }
  })
})

app.on('will-quit', () => {
  stopBackend()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
