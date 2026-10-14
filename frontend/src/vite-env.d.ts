/// <reference types="vite/client" />

/** Pushed from main for the tab whose guest content the event happened on. */
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

interface Window {
  electronAPI?: {
    scanWebview: (webContentsId: number) => Promise<unknown>
    runtimeInvoke: (request: { targetId: number; name: string; params: unknown }) => Promise<unknown>
    browserUI: import('../electron/browserUITypes').BrowserUIBridge
    // Guest tabs are hosted as main-owned WebContentsViews; the renderer only
    // ever addresses one by its webContents id. See BrowserWebView.tsx.
    browser: {
      createTab: (url: string) => Promise<{ webContentsId: number; zoom: number } | null>
      closeTab: (webContentsId: number) => Promise<void>
      getTabInfo: (webContentsId: number) => Promise<{ url: string; title: string } | null>
      navigate: (webContentsId: number, url: string) => Promise<void>
      goBack: (webContentsId: number) => Promise<void>
      goForward: (webContentsId: number) => Promise<void>
      reload: (webContentsId: number) => Promise<void>
      stop: (webContentsId: number) => Promise<void>
      setActiveTab: (webContentsId: number) => void
      setBounds: (webContentsId: number, bounds: { x: number; y: number; width: number; height: number }) => void
      onTabEvent: (listener: (event: BrowserTabEvent) => void) => () => void
      onPopupTab: (listener: (event: { webContentsId: number; url: string; disposition: string }) => void) => () => void
      onPopupClosed: (listener: (webContentsId: number) => void) => () => void
      setAgentLock: (webContentsId: number, locked: boolean) => Promise<boolean>
      onAgentStopRequested: (listener: (webContentsId: number) => void) => () => void
      captureBackdrop: (
        webContentsId: number | null,
        region?: { x: number; y: number; width: number; height: number },
      ) => Promise<{ image: string; luminance: number } | null>
      captureFrame: (webContentsId: number) => Promise<{ image: string; luminance: number } | null>
    }
    // Provider configs live in main's safeStorage-backed store; see providerApiClient.ts.
    providers: {
      getAll: () => Promise<import('./types/providerTypes').ClientProviderConfig[]>
      save: (
        config: import('./types/providerTypes').ClientProviderConfig & { set_active?: boolean },
      ) => Promise<import('./types/providerTypes').ClientProviderConfig>
      delete: (providerId: string) => Promise<{ ok: boolean }>
      setActive: (payload: { id: string | null; selected_model?: string }) => Promise<{ ok: boolean }>
      getActive: () => Promise<import('./types/providerTypes').ClientProviderConfig | null>
    }
  }
}
