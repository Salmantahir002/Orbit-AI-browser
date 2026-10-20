import { app, dialog, ipcMain, session, shell, WebContentsView } from 'electron'
import type { BrowserWindow, DownloadItem, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserProfileStore, isBrowserUrl } from './browserProfileStore.js'
import type { BrowserUpdater } from './browserUpdater.js'
import { SitePermissions } from './sitePermissions.js'
import { SiteConnection, initialConnection } from './siteConnection.js'
import type { CdpSession } from './browserRuntime/cdpSession.js'
import { ZOOM_LEVELS, type BrowserCommand, type BrowserPanel, type ClearDataRequest, type DownloadEntry, type OverlayState } from './browserUITypes.js'

type WindowSurface = { window: BrowserWindow; overlay: WebContentsView; ready: boolean; state: OverlayState | null; activeTarget: number | null; siteAnchor: { x: number; y: number } }
type ControllerOptions = {
  createWindow: () => Promise<void>
  loadOverlay: (contents: WebContents) => Promise<void>
  getTarget: (window: BrowserWindow, id: number) => WebContentsView | null
  updater: BrowserUpdater
}
const PANELS: BrowserPanel[] = ['menu', 'history', 'downloads', 'bookmarks', 'clear-data', 'settings', 'about', 'connection']
const COMMANDS: BrowserCommand[] = ['new-tab', 'bookmark-page', 'toggle-bookmarks', 'focus-address', 'close-tab', 'next-tab', 'previous-tab', 'provider-settings']

/** A transparent native view paints browser chrome above guest pages without hiding or unloading them. */
export class BrowserUIController {
  readonly profile = new BrowserProfileStore()
  readonly permissions = new SitePermissions((prompt) => {
    const surface = [...this.surfaces.values()].find((entry) => entry.activeTarget === prompt.targetId && this.options.getTarget(entry.window, prompt.targetId))
    if (!surface?.ready || surface.window.isDestroyed() || surface.state?.panel === 'permission') return false
    this.show(surface, 'permission', prompt.targetId, surface.siteAnchor, { permission: prompt })
    return true
  }, (prompt) => {
    const surface = [...this.surfaces.values()].find((entry) => entry.state?.permission?.id === prompt.id)
    if (surface) this.hide(surface)
  })
  private readonly connections = new Map<number, SiteConnection>()
  private readonly surfaces = new Map<number, WindowSurface>()
  private readonly liveDownloads = new Map<string, DownloadItem>()
  /** Downloads started since launch. The profile also holds earlier sessions' history. */
  private readonly sessionDownloadIds = new Set<string>()
  private readonly saveAsRequests = new Set<string>()
  private readonly siteZoom = new Map<string, number>()
  private readonly homeZoom = new Map<number, number>()
  private readonly options: ControllerOptions

  constructor(options: ControllerOptions) {
    this.options = options
    this.profile.onChange = () => this.broadcast()
    // The shell shows the toolbar badge; the overlay shows the About panel's update controls.
    options.updater.onChange = (state) => this.sendToSurfaces('browser-ui:update', state)
    this.registerIPC()
    this.permissions.install(session.defaultSession)
    // Install once for the shared browsing session, including downloads initiated by popup tabs.
    session.defaultSession.on('will-download', (_event, item, contents) => this.trackDownload(item, contents))
    app.on('will-quit', () => this.profile.flush())
  }

  async attach(window: BrowserWindow, shellLoaded: Promise<void>): Promise<void> {
    const overlay = new WebContentsView({ webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    } })
    overlay.setBackgroundColor('#00000000')
    overlay.setVisible(false)
    window.contentView.addChildView(overlay)
    const surface: WindowSurface = { window, overlay, ready: false, state: null, activeTarget: null, siteAnchor: { x: 132, y: 84 } }
    this.surfaces.set(window.webContents.id, surface)
    const shellId = window.webContents.id
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    overlay.webContents.on('will-navigate', (event) => event.preventDefault())
    overlay.webContents.on('render-process-gone', () => { surface.ready = false; this.hide(surface); void this.options.loadOverlay(overlay.webContents) })
    const resize = () => { const [width, height] = window.getContentSize(); overlay.setBounds({ x: 0, y: 0, width, height }) }
    resize()
    window.on('resize', resize)
    window.on('closed', () => { this.hide(surface); this.surfaces.delete(shellId); if (!overlay.webContents.isDestroyed()) overlay.webContents.close() })
    window.webContents.on('did-start-navigation', (event) => { if (event.isMainFrame && !event.isSameDocument) this.hide(surface) })
    this.attachShortcuts(window.webContents, window)
    this.attachShortcuts(overlay.webContents, window)
    await shellLoaded
    if (!window.isDestroyed()) await this.options.loadOverlay(overlay.webContents)
  }

  private surfaceFor(event: IpcMainInvokeEvent | IpcMainEvent): WindowSurface {
    const frame = event.senderFrame
    if (!frame || frame.routingId !== event.sender.mainFrame.routingId || frame.processId !== event.sender.mainFrame.processId) throw new Error('Browser controls require the app frame.')
    const surface = [...this.surfaces.values()].find((entry) => entry.window.webContents.id === event.sender.id || entry.overlay.webContents.id === event.sender.id)
    if (!surface || surface.window.isDestroyed()) throw new Error('Browser controls require an Orbit window.')
    return surface
  }

  private broadcast(): void {
    this.sendToSurfaces('browser-ui:snapshot', this.profile.snapshot())
  }

  private sendToSurfaces(channel: string, payload: unknown): void {
    for (const surface of this.surfaces.values()) {
      if (!surface.window.isDestroyed()) surface.window.webContents.send(channel, payload)
      if (!surface.overlay.webContents.isDestroyed()) surface.overlay.webContents.send(channel, payload)
    }
  }

  raise(window: BrowserWindow): void {
    const surface = this.surfaces.get(window.webContents.id)
    if (surface?.state && surface.ready && !window.isDestroyed()) window.contentView.addChildView(surface.overlay)
  }

  setActiveTarget(window: BrowserWindow, id: number): void {
    const surface = this.surfaces.get(window.webContents.id)
    if (surface) {
      if (surface.activeTarget !== id && ['permission', 'connection'].includes(surface.state?.panel ?? '')) this.hide(surface)
      const changed = surface.activeTarget !== id
      surface.activeTarget = id
      if (changed) surface.window.webContents.send('browser-ui:connection', { targetId: id, connection: this.connections.get(id)?.state ?? initialConnection('about:blank') })
    }
    this.raise(window)
  }

  attachSiteControls(contents: WebContents, cdp: CdpSession | null): void {
    this.permissions.attach(contents)
    const tracker = new SiteConnection((connection) => {
      for (const surface of this.surfaces.values()) {
        if (!this.options.getTarget(surface.window, contents.id)) continue
        if (surface.activeTarget === contents.id) surface.window.webContents.send('browser-ui:connection', { targetId: contents.id, connection })
        if (surface.state?.panel === 'connection' && surface.state.targetId === contents.id) {
          surface.state.connection = connection
          surface.overlay.webContents.send('browser-ui:overlay', surface.state)
        }
      }
    })
    this.connections.set(contents.id, tracker)
    tracker.attach(contents, cdp)
    const closeSitePopup = () => {
      for (const surface of this.surfaces.values()) if (surface.state?.targetId === contents.id && ['permission', 'connection'].includes(surface.state.panel)) this.hide(surface)
    }
    contents.on('did-start-navigation', (event) => { if (event.isMainFrame && !event.isSameDocument) closeSitePopup() })
    contents.once('destroyed', () => { closeSitePopup(); this.connections.delete(contents.id) })
  }

  initializePageZoom(contents: WebContents): void {
    this.homeZoom.set(contents.id, this.profile.settings.defaultZoom)
    contents.setZoomFactor(this.profile.settings.defaultZoom / 100)
    const id = contents.id
    contents.once('destroyed', () => this.homeZoom.delete(id))
  }

  getPageZoom(contents?: WebContents | null): number {
    if (!contents) return this.profile.settings.defaultZoom
    if (!contents.getURL() || contents.getURL() === 'about:blank') return this.homeZoom.get(contents.id) ?? this.profile.settings.defaultZoom
    return Math.round(contents.getZoomFactor() * 100)
  }

  applyPageZoom(contents: WebContents): void {
    try {
      const url = new URL(contents.getURL())
      const zoom = url.href === 'about:blank' ? this.getPageZoom(contents) : this.siteZoom.get(url.origin) ?? this.profile.settings.defaultZoom
      contents.setZoomFactor(zoom / 100)
    } catch { /* Pages without a standard origin use the creation-time default. */ }
  }

  private show(surface: WindowSurface, panel: BrowserPanel, targetId = surface.activeTarget, anchor = { x: surface.window.getContentSize()[0] - 12, y: 72 }, extra: Partial<OverlayState> = {}): void {
    if (surface.state?.permission) this.hide(surface)
    const target = targetId === null ? null : this.options.getTarget(surface.window, targetId)?.webContents
    surface.state = { panel, anchor, targetId: target?.id ?? null, url: target?.getURL() ?? '', title: target?.getTitle() ?? '', zoom: this.getPageZoom(target), ...extra,
      ...(panel === 'connection' ? { connection: this.connections.get(target?.id ?? -1)?.state ?? initialConnection('about:blank') } : {}) }
    if (surface.ready) {
      surface.overlay.webContents.send('browser-ui:overlay', surface.state)
      surface.overlay.setVisible(true)
      this.raise(surface.window)
      surface.overlay.webContents.focus()
    }
    surface.window.webContents.send('browser-ui:visibility', true)
  }

  private hide(surface: WindowSurface): void {
    if (!surface.state) return
    const sitePopup = surface.state.panel === 'connection' || surface.state.panel === 'permission'
    const prompt = surface.state?.permission
    surface.state = null
    if (prompt) this.permissions.decide(prompt.id, prompt.targetId, false)
    if (!surface.overlay.webContents.isDestroyed()) { surface.overlay.webContents.send('browser-ui:overlay', null); surface.overlay.setVisible(false) }
    if (!surface.window.isDestroyed()) {
      surface.window.webContents.send('browser-ui:visibility', false)
      surface.window.webContents.focus()
      surface.window.webContents.send('browser-ui:restore-focus', sitePopup ? 'site' : 'menu')
    }
  }

  private sendCommand(surface: WindowSurface, command: BrowserCommand, url?: string): void {
    surface.window.webContents.send('browser-ui:command', { command, url })
  }

  attachShortcuts(contents: WebContents, window: BrowserWindow): void {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const surface = this.surfaces.get(window.webContents.id)
      if (!surface) return
      const key = input.key.toLowerCase()
      const modifier = input.control || input.meta
      let handled = true
      if (input.alt && key === 'f') this.show(surface, 'menu')
      else if (key === 'f11') window.setFullScreen(!window.isFullScreen())
      else if (!modifier || input.alt) handled = false
      else if (key === 't' && !input.shift) this.sendCommand(surface, 'new-tab')
      else if (key === 'n' && !input.shift) void this.options.createWindow()
      else if (key === 'h' && !input.shift) this.show(surface, 'history')
      else if (key === 'j' && !input.shift) this.show(surface, 'downloads')
      else if (key === 'o' && input.shift) this.show(surface, 'bookmarks')
      else if (key === 'b' && input.shift) this.profile.updateSettings({ showBookmarksBar: !this.profile.settings.showBookmarksBar })
      else if (key === 'd' && !input.shift) this.sendCommand(surface, 'bookmark-page')
      else if (key === 'l') { this.hide(surface); this.sendCommand(surface, 'focus-address') }
      else if (key === 'w') this.sendCommand(surface, 'close-tab')
      else if (key === 'tab') this.sendCommand(surface, input.shift ? 'previous-tab' : 'next-tab')
      else if (key === 'delete' && input.shift) this.show(surface, 'clear-data')
      else if (['=', '+', '-', '0'].includes(key)) this.setZoom(surface, surface.activeTarget, key === '-' ? 'out' : key === '0' ? 'reset' : 'in')
      else if (key === 'p') this.options.getTarget(window, surface.activeTarget ?? -1)?.webContents.print()
      else handled = false
      if (handled) event.preventDefault()
    })
  }

  private setZoom(surface: WindowSurface, id: number | null, direction: unknown): number {
    const target = id === null ? undefined : this.options.getTarget(surface.window, id)?.webContents
    if (!target || target.isDestroyed()) return this.profile.settings.defaultZoom
    const current = this.getPageZoom(target)
    const next = direction === 'reset' ? 100 : direction === 'in' ? (ZOOM_LEVELS.find((value) => value > current) ?? 500) : ([...ZOOM_LEVELS].reverse().find((value) => value < current) ?? 25)
    target.setZoomFactor(next / 100)
    surface.window.webContents.send('browser:tab-event', { webContentsId: target.id, type: 'zoom-changed', zoom: next })
    if (target.getURL() === 'about:blank') this.homeZoom.set(target.id, next)
    else { try { this.siteZoom.set(new URL(target.getURL()).origin, next) } catch { /* Ignore nonstandard origins. */ } }
    if (surface.state) { surface.state.zoom = next; surface.overlay.webContents.send('browser-ui:overlay', surface.state) }
    return next
  }

  private registerIPC(): void {
    const handle = (channel: string, listener: (surface: WindowSurface, ...args: unknown[]) => unknown) => {
      ipcMain.handle(`browser-ui:${channel}`, (event, ...args: unknown[]) => listener(this.surfaceFor(event), ...args))
    }
    handle('snapshot', () => this.profile.snapshot())
    handle('site-anchor', (surface, value) => {
      const point = value as { x?: unknown; y?: unknown } | null
      if (point && typeof point.x === 'number' && typeof point.y === 'number' && Number.isFinite(point.x) && Number.isFinite(point.y)) surface.siteAnchor = { x: point.x, y: point.y }
    })
    handle('connection', (surface, id) => {
      if (id === null) return initialConnection('about:blank')
      if (!Number.isInteger(id) || !this.options.getTarget(surface.window, id as number)) throw new Error('This tab does not belong to this window.')
      return this.connections.get(id as number)?.state ?? { url: '', status: 'unavailable' }
    })
    ipcMain.handle('browser-ui:permission-decision', (event, id: unknown, allow: unknown) => {
      const surface = this.surfaceFor(event)
      if (event.sender.id !== surface.overlay.webContents.id || typeof id !== 'string' || typeof allow !== 'boolean') throw new Error('Permission decisions require the trusted popup.')
      const prompt = surface.state?.permission
      if (prompt?.id === id && surface.activeTarget === prompt.targetId && this.options.getTarget(surface.window, prompt.targetId)) this.permissions.decide(id, prompt.targetId, allow)
    })
    handle('show', (surface, panel, targetId, anchor) => {
      if (!PANELS.includes(panel as BrowserPanel)) throw new Error('Unknown browser panel.')
      const point = anchor as { x: number; y: number } | undefined
      const safeAnchor = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : undefined
      const id = Number.isInteger(targetId) ? targetId as number : surface.activeTarget
      if (panel === 'connection' && (id !== surface.activeTarget || id === null || !this.options.getTarget(surface.window, id))) throw new Error('Connection details require the active tab.')
      this.show(surface, panel as BrowserPanel, id, safeAnchor ?? (panel === 'connection' ? surface.siteAnchor : undefined))
    })
    handle('close', (surface) => this.hide(surface))
    ipcMain.on('browser-ui:ready', (event) => {
      try {
        const surface = this.surfaceFor(event)
        if (surface.overlay.webContents.id !== event.sender.id) return
        surface.ready = true
        if (surface.state) { surface.overlay.webContents.send('browser-ui:overlay', surface.state); surface.overlay.setVisible(true); this.raise(surface.window) }
      } catch { /* Ignore messages from guest pages. */ }
    })
    handle('command', (surface, command, url) => {
      if (typeof url === 'string') {
        if (!isBrowserUrl(url)) throw new Error('This page URL cannot be opened.')
        this.sendCommand(surface, 'new-tab', url)
      } else if (COMMANDS.includes(command as BrowserCommand)) {
        if (command === 'toggle-bookmarks') this.profile.updateSettings({ showBookmarksBar: !this.profile.settings.showBookmarksBar })
        else this.sendCommand(surface, command as BrowserCommand)
      }
    })
    handle('new-window', () => this.options.createWindow())
    handle('close-window', (surface) => surface.window.close())
    handle('exit', () => app.quit())
    handle('zoom', (surface, id, direction) => this.setZoom(surface, Number.isInteger(id) ? id as number : null, direction))
    handle('fullscreen', (surface) => surface.window.setFullScreen(!surface.window.isFullScreen()))
    handle('print', (surface, id) => { if (Number.isInteger(id)) this.options.getTarget(surface.window, id as number)?.webContents.print() })
    handle('save-bookmark', (_surface, value) => this.profile.saveBookmark(value as Parameters<BrowserProfileStore['saveBookmark']>[0]))
    handle('delete-bookmark', (_surface, id) => { this.profile.bookmarks = this.profile.bookmarks.filter((entry) => entry.id !== id); this.profile.changed() })
    handle('import-bookmarks', (_surface, value) => this.profile.importBookmarks(value as Parameters<BrowserProfileStore['importBookmarks']>[0]))
    handle('delete-history', (_surface, ids) => {
      if (!Array.isArray(ids) || ids.length > 10_000) throw new Error('Invalid history selection.')
      this.profile.history = this.profile.history.filter((entry) => !ids.includes(entry.id)); this.profile.changed()
    })
    handle('settings', (_surface, value) => this.profile.updateSettings(value as Parameters<BrowserProfileStore['updateSettings']>[0]))
    handle('choose-folder', async (surface) => {
      const result = await dialog.showOpenDialog(surface.window, { title: 'Choose download folder', defaultPath: this.profile.settings.downloadFolder, properties: ['openDirectory', 'createDirectory'] })
      if (!result.canceled && result.filePaths[0]) { this.profile.settings.downloadFolder = result.filePaths[0]; this.profile.changed() }
    })
    handle('open-folder', async () => { mkdirSync(this.profile.settings.downloadFolder, { recursive: true }); const error = await shell.openPath(this.profile.settings.downloadFolder); if (error) throw new Error(error) })
    handle('download-action', (surface, id, action) => this.downloadAction(surface, id, action))
    handle('update-state', () => this.options.updater.state)
    handle('update-check', () => this.options.updater.check())
    handle('update-download', () => this.options.updater.download())
    handle('update-install', () => this.options.updater.install())
    handle('clear-data', async (_surface, payload) => {
      const request = payload as ClearDataRequest
      if (!request || !['hour', 'day', 'week', 'month', 'all'].includes(request.range)) throw new Error('Choose a valid time range.')
      const durations = { hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_419_200_000, all: Infinity }
      const cutoff = Date.now() - durations[request.range]
      // Electron clears site storage and cache for the entire session; the UI explains this explicitly.
      if (request.cookies) await session.defaultSession.clearData({ dataTypes: ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch'] })
      if (request.cache) await session.defaultSession.clearCache()
      if (request.history) this.profile.history = this.profile.history.filter((entry) => entry.visitedAt < cutoff)
      if (request.downloads) this.profile.downloads = this.profile.downloads.filter((entry) => entry.startedAt < cutoff || entry.state === 'progressing' || this.liveDownloads.has(entry.id))
      this.profile.changed()
    })
  }

  private trackDownload(item: DownloadItem, contents: WebContents): void {
    const owner = [...this.surfaces.values()].find((surface) => this.options.getTarget(surface.window, contents.id))
    const settings = this.profile.settings
    let savePath: string
    try {
      mkdirSync(settings.downloadFolder, { recursive: true })
      let filename = Array.from(path.basename(item.getFilename())).map((character) => character.charCodeAt(0) < 32 ? '_' : character).join('').replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '') || 'download'
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(filename)) filename = `_${filename}`
      savePath = path.join(settings.downloadFolder, filename)
      const extension = path.extname(filename)
      const stem = path.basename(filename, extension)
      let duplicate = 1
      while (existsSync(savePath) || this.profile.downloads.some((entry) => this.liveDownloads.has(entry.id) && entry.savePath === savePath)) savePath = path.join(settings.downloadFolder, `${stem} (${duplicate++})${extension}`)
      const forcedSaveAs = item.getURLChain().some((url) => this.saveAsRequests.delete(`${contents.id}:${url}`))
      if (settings.askWhereToSave || forcedSaveAs) {
        const result = owner ? dialog.showSaveDialogSync(owner.window, { defaultPath: savePath }) : dialog.showSaveDialogSync({ defaultPath: savePath })
        if (!result) { item.cancel(); return }
        savePath = result
      }
      item.setSavePath(savePath)
    } catch (error) { console.error('[downloads] Could not prepare download:', error); item.cancel(); return }
    const entry: DownloadEntry = { id: randomUUID(), filename: path.basename(savePath), url: item.getURL(), savePath, startedAt: Date.now(), receivedBytes: 0, totalBytes: item.getTotalBytes(), bytesPerSecond: 0, state: 'progressing', paused: false, canResume: false }
    this.profile.downloads.unshift(entry)
    this.profile.downloads = this.profile.downloads.filter((record, index) => index < 500 || this.liveDownloads.has(record.id))
    this.liveDownloads.set(entry.id, item)
    this.sessionDownloadIds.add(entry.id)
    let lastUpdate = Date.now()
    let lastBytes = 0
    const update = (force = false) => {
      const now = Date.now()
      if (!force && now - lastUpdate < 150) return
      const bytes = item.getReceivedBytes()
      entry.bytesPerSecond = item.isPaused() ? 0 : Math.max(0, (bytes - lastBytes) * 1000 / Math.max(1, now - lastUpdate))
      lastUpdate = now; lastBytes = bytes
      Object.assign(entry, { receivedBytes: bytes, totalBytes: item.getTotalBytes(), state: item.getState(), paused: item.isPaused(), canResume: item.canResume() })
      for (const surface of this.surfaces.values()) {
        if (!surface.overlay.webContents.isDestroyed()) surface.overlay.webContents.send('browser-ui:download', entry)
      }
      this.profile.changed(false)
    }
    item.on('updated', () => update())
    item.once('done', (_event, state) => { update(true); entry.state = state; entry.paused = false; entry.canResume = false; entry.bytesPerSecond = 0; this.liveDownloads.delete(entry.id); this.profile.changed() })
    this.profile.changed()
    if (owner && !owner.state) this.show(owner, 'downloads')
  }

  /**
   * Downloads that finished during this run of the app and whose file is still
   * on disk, newest first. These, and only these, are what agent mode may
   * attach to a page without the user picking the file themselves.
   */
  sessionDownloads(): DownloadEntry[] {
    return this.profile.downloads.filter((entry) =>
      this.sessionDownloadIds.has(entry.id) && entry.state === 'completed' && existsSync(entry.savePath))
  }

  requestSaveAs(contents: WebContents, url: string): void {
    const key = `${contents.id}:${url}`
    this.saveAsRequests.add(key)
    setTimeout(() => this.saveAsRequests.delete(key), 60_000).unref()
    contents.downloadURL(url)
  }

  private async downloadAction(surface: WindowSurface, id: unknown, action: unknown): Promise<void> {
    const entry = this.profile.downloads.find((value) => value.id === id)
    if (!entry) throw new Error('This download is no longer in the list.')
    const item = this.liveDownloads.get(entry.id)
    if (action === 'pause' && item && entry.state === 'progressing') { item.pause(); entry.paused = true }
    else if (action === 'resume' && item && (item.isPaused() || item.canResume())) { item.resume(); entry.paused = false }
    else if (action === 'cancel' && item) item.cancel()
    else if (action === 'open' && entry.state === 'completed') {
      if (!existsSync(entry.savePath)) throw new Error('The downloaded file has been moved or deleted.')
      const error = await shell.openPath(entry.savePath); if (error) throw new Error(error)
    } else if (action === 'show' && existsSync(entry.savePath)) shell.showItemInFolder(entry.savePath)
    else if (action === 'remove' && !item) this.profile.downloads = this.profile.downloads.filter((value) => value.id !== entry.id)
    else if (action === 'retry' && !item && isBrowserUrl(entry.url)) {
      const target = this.options.getTarget(surface.window, surface.state?.targetId ?? surface.activeTarget ?? -1)
      if (!target) throw new Error('Open a browser tab before retrying this download.')
      target.webContents.downloadURL(entry.url)
    } else throw new Error('This action is unavailable for the download.')
    this.profile.changed()
  }
}
