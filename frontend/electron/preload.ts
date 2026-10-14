import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { RUNTIME_INVOKE_CHANNEL } from './browserRuntime/runtimeContract.js'
import type { BrowserUIBridge, BrowserSnapshot, OverlayState, BrowserCommand, DownloadEntry } from './browserUITypes.js'
import type { ClientProviderView, ProviderSaveRequest } from './providerSecureStore.js'

function subscribe<T>(channel: string, listener: (value: T) => void) {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const browserUI: BrowserUIBridge = {
  snapshot: () => ipcRenderer.invoke('browser-ui:snapshot'),
  show: (panel, targetId, anchor) => ipcRenderer.invoke('browser-ui:show', panel, targetId, anchor),
  close: () => ipcRenderer.invoke('browser-ui:close'),
  ready: () => ipcRenderer.send('browser-ui:ready'),
  command: (command, url) => ipcRenderer.invoke('browser-ui:command', command, url),
  newWindow: () => ipcRenderer.invoke('browser-ui:new-window'),
  closeWindow: () => ipcRenderer.invoke('browser-ui:close-window'),
  exit: () => ipcRenderer.invoke('browser-ui:exit'),
  zoom: (id, direction) => ipcRenderer.invoke('browser-ui:zoom', id, direction),
  fullscreen: () => ipcRenderer.invoke('browser-ui:fullscreen'),
  print: (id) => ipcRenderer.invoke('browser-ui:print', id),
  saveBookmark: (bookmark) => ipcRenderer.invoke('browser-ui:save-bookmark', bookmark),
  deleteBookmark: (id) => ipcRenderer.invoke('browser-ui:delete-bookmark', id),
  importBookmarks: (bookmarks) => ipcRenderer.invoke('browser-ui:import-bookmarks', bookmarks),
  deleteHistory: (ids) => ipcRenderer.invoke('browser-ui:delete-history', ids),
  clearData: (request) => ipcRenderer.invoke('browser-ui:clear-data', request),
  updateSettings: (settings) => ipcRenderer.invoke('browser-ui:settings', settings),
  chooseDownloadFolder: () => ipcRenderer.invoke('browser-ui:choose-folder'),
  openDownloadFolder: () => ipcRenderer.invoke('browser-ui:open-folder'),
  downloadAction: (id, action) => ipcRenderer.invoke('browser-ui:download-action', id, action),
  onSnapshot: (listener) => subscribe<BrowserSnapshot>('browser-ui:snapshot', listener),
  onDownload: (listener) => subscribe<DownloadEntry>('browser-ui:download', listener),
  onOverlay: (listener) => subscribe<OverlayState>('browser-ui:overlay', listener),
  onCommand: (listener) => subscribe<{ command: BrowserCommand; url?: string }>('browser-ui:command', listener),
  onVisibility: (listener) => subscribe<boolean>('browser-ui:visibility', listener),
  onRestoreFocus: (listener) => subscribe<void>('browser-ui:restore-focus', listener),
}

/** Mirrors the shape main.ts sends over 'browser:tab-event' (see BrowserTabEvent in src/vite-env.d.ts). */
type BrowserTabEvent = {
  webContentsId: number
  type: 'did-start-loading' | 'did-stop-loading' | 'did-finish-load' | 'did-navigate' | 'did-navigate-in-page' | 'did-fail-load' | 'page-favicon-updated' | 'page-title-updated' | 'zoom-changed'
  zoom?: number
  url?: string
  title?: string
  favicon?: string
  errorCode?: number
  errorDescription?: string
}

// The bridge exposes one purpose-built function per IPC channel. There is deliberately no
// generic `invoke(channel)`: the renderer can only reach what is listed here.
const electronAPI = {
  browserUI,
  scanWebview: (webContentsId: number) => ipcRenderer.invoke('security:scan-webview', webContentsId) as Promise<unknown>,
  runtimeInvoke: (request: unknown) => ipcRenderer.invoke(RUNTIME_INVOKE_CHANNEL, request) as Promise<unknown>,
  // Guest tabs are hosted as main-owned WebContentsViews (see main.ts), keyed
  // by webContents id — never exposed to the renderer as a DOM element.
  browser: {
    createTab: (url: string) => ipcRenderer.invoke('browser:create-tab', url) as Promise<{ webContentsId: number; zoom: number } | null>,
    closeTab: (webContentsId: number) => ipcRenderer.invoke('browser:close-tab', webContentsId) as Promise<void>,
    getTabInfo: (webContentsId: number) => ipcRenderer.invoke('browser:get-tab-info', webContentsId) as Promise<{ url: string; title: string } | null>,
    navigate: (webContentsId: number, url: string) => ipcRenderer.invoke('browser:navigate', webContentsId, url) as Promise<void>,
    goBack: (webContentsId: number) => ipcRenderer.invoke('browser:go-back', webContentsId) as Promise<void>,
    goForward: (webContentsId: number) => ipcRenderer.invoke('browser:go-forward', webContentsId) as Promise<void>,
    reload: (webContentsId: number) => ipcRenderer.invoke('browser:reload', webContentsId) as Promise<void>,
    stop: (webContentsId: number) => ipcRenderer.invoke('browser:stop', webContentsId) as Promise<void>,
    setActiveTab: (webContentsId: number) => ipcRenderer.send('browser:set-active-tab', webContentsId),
    // Fire-and-forget: this fires on every resize/tab-switch, an invoke round trip isn't worth it.
    setBounds: (webContentsId: number, bounds: { x: number; y: number; width: number; height: number }) => {
      ipcRenderer.send('browser:set-bounds', webContentsId, bounds)
    },
    onTabEvent: (listener: (event: BrowserTabEvent) => void) => {
      const handler = (_event: IpcRendererEvent, payload: BrowserTabEvent) => listener(payload)
      ipcRenderer.on('browser:tab-event', handler)
      return () => ipcRenderer.removeListener('browser:tab-event', handler)
    },
    onPopupTab: (listener: (event: { webContentsId: number; url: string; disposition: string }) => void) => {
      const handler = (_event: IpcRendererEvent, payload: { webContentsId: number; url: string; disposition: string }) => listener(payload)
      ipcRenderer.on('browser:popup-tab', handler)
      return () => ipcRenderer.removeListener('browser:popup-tab', handler)
    },
    onPopupClosed: (listener: (webContentsId: number) => void) => {
      const handler = (_event: IpcRendererEvent, webContentsId: number) => listener(webContentsId)
      ipcRenderer.on('browser:popup-closed', handler)
      return () => ipcRenderer.removeListener('browser:popup-closed', handler)
    },
    // Blocks the user's own input on a tab while the agent drives it.
    setAgentLock: (webContentsId: number, locked: boolean) =>
      ipcRenderer.invoke('browser:set-agent-lock', webContentsId, locked) as Promise<boolean>,
    // The user pressed Stop in a locked tab's "agent mode is active" toast.
    onAgentStopRequested: (listener: (webContentsId: number) => void) => {
      const handler = (_event: IpcRendererEvent, webContentsId: number) => listener(webContentsId)
      ipcRenderer.on('agent:stop-requested', handler)
      return () => ipcRenderer.removeListener('agent:stop-requested', handler)
    },
    // A tiny blurred-backdrop frame of a tab (or, with a null id, of a shell region) for the glass assistant panel.
    captureBackdrop: (webContentsId: number | null, region?: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('browser:capture-backdrop', webContentsId, region) as Promise<{ image: string; luminance: number } | null>,
    // One full frame of a tab, shown in its place while a report drawer hides it.
    captureFrame: (webContentsId: number) =>
      ipcRenderer.invoke('browser:capture-frame', webContentsId) as Promise<{ image: string; luminance: number } | null>,
  },
  // Secure Provider Storage APIs
  providers: {
    getAll: () => ipcRenderer.invoke('providers:get-all') as Promise<ClientProviderView[]>,
    save: (config: ProviderSaveRequest) => ipcRenderer.invoke('providers:save', config) as Promise<ClientProviderView>,
    delete: (providerId: string) => ipcRenderer.invoke('providers:delete', providerId) as Promise<{ ok: boolean }>,
    setActive: (payload: { id: string | null; selected_model?: string }) =>
      ipcRenderer.invoke('providers:set-active', payload) as Promise<{ ok: boolean }>,
    getActive: () => ipcRenderer.invoke('providers:get-active') as Promise<ClientProviderView | null>,
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
