import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { RUNTIME_INVOKE_CHANNEL } from './browserRuntime/runtimeContract.js'

/** Mirrors the shape main.ts sends over 'browser:tab-event' (see BrowserTabEvent in src/vite-env.d.ts). */
type BrowserTabEvent = {
  webContentsId: number
  type: 'did-start-loading' | 'did-stop-loading' | 'did-finish-load' | 'did-navigate' | 'did-navigate-in-page' | 'did-fail-load' | 'page-favicon-updated' | 'page-title-updated'
  url?: string
  title?: string
  favicon?: string
  errorCode?: number
  errorDescription?: string
}

// The bridge exposes one purpose-built function per IPC channel. There is deliberately no
// generic `invoke(channel)`: the renderer can only reach what is listed here.
const electronAPI = {
  scanWebview: (webContentsId: number) => ipcRenderer.invoke('security:scan-webview', webContentsId) as Promise<unknown>,
  runtimeInvoke: (request: unknown) => ipcRenderer.invoke(RUNTIME_INVOKE_CHANNEL, request) as Promise<unknown>,
  // Guest tabs are hosted as main-owned WebContentsViews (see main.ts), keyed
  // by webContents id — never exposed to the renderer as a DOM element.
  browser: {
    createTab: (url: string) => ipcRenderer.invoke('browser:create-tab', url) as Promise<{ webContentsId: number } | null>,
    closeTab: (webContentsId: number) => ipcRenderer.invoke('browser:close-tab', webContentsId) as Promise<void>,
    getTabInfo: (webContentsId: number) => ipcRenderer.invoke('browser:get-tab-info', webContentsId) as Promise<{ url: string; title: string } | null>,
    navigate: (webContentsId: number, url: string) => ipcRenderer.invoke('browser:navigate', webContentsId, url) as Promise<void>,
    goBack: (webContentsId: number) => ipcRenderer.invoke('browser:go-back', webContentsId) as Promise<void>,
    goForward: (webContentsId: number) => ipcRenderer.invoke('browser:go-forward', webContentsId) as Promise<void>,
    reload: (webContentsId: number) => ipcRenderer.invoke('browser:reload', webContentsId) as Promise<void>,
    stop: (webContentsId: number) => ipcRenderer.invoke('browser:stop', webContentsId) as Promise<void>,
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
  },
  // Secure Provider Storage APIs
  providers: {
    getAll: () => ipcRenderer.invoke('providers:get-all') as Promise<any[]>,
    save: (config: any) => ipcRenderer.invoke('providers:save', config) as Promise<any>,
    delete: (providerId: string) => ipcRenderer.invoke('providers:delete', providerId) as Promise<{ ok: boolean }>,
    setActive: (payload: { id: string | null; selected_model?: string }) =>
      ipcRenderer.invoke('providers:set-active', payload) as Promise<{ ok: boolean }>,
    getActive: () => ipcRenderer.invoke('providers:get-active') as Promise<any>,
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
