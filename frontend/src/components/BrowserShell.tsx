import { memo, startTransition, useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef, CSSProperties } from 'react'
import { createDeferredComponent } from '../utils/deferredComponent'
import { BookmarkBar } from './BookmarkBar'
import { BrowserToolbar } from './BrowserToolbar'
import { BrowserWebView, type BrowserWebViewHandle } from './BrowserWebView'
import { BrowserLogo } from './BrowserLogo'
import { LoadingProgressBar } from './LoadingProgressBar'
import { extractPageContent } from '../services/pageContentExtractor'
import { checkWebpage } from '../services/backendApiClient'
import type { AnalysisDetails } from '../types/analysisDetailsTypes'
import type { BookmarkItem } from '../types/bookmarkTypes'
import type { SecurityCheckResponse, WebpageContent } from '../types/securityTypes'
import { extractDomainForFavicon, getFaviconCandidates, resolveNavigationUrl } from '../services/urlUtils'
import type { BrowserPanel } from '../../electron/browserUITypes'
import '../styles/browser-panels.css'

// Everything the first shell frame does not show is its own chunk: the assistant (chat + agent
// runtime), the provider settings modal, and the two report drawers. They are prefetched once the
// shell is idle (see the effect in BrowserShell), so opening one does not wait on a chunk fetch.
const AiAssistantSidebar = createDeferredComponent(() => import('./AiAssistantSidebar').then((m) => m.AiAssistantSidebar))
const PromptAnalysisDetailsPanel = createDeferredComponent(() => import('./PromptAnalysisDetailsPanel').then((m) => m.PromptAnalysisDetailsPanel))
const WebpageAnalysisDetailsPanel = createDeferredComponent(() => import('./WebpageAnalysisDetailsPanel').then((m) => m.WebpageAnalysisDetailsPanel))
const ProviderSettingsModal = createDeferredComponent(() => import('./ProviderSettingsModal').then((m) => m.ProviderSettingsModal))

const DEFAULT_BROWSER_URL = 'about:blank'
const HOMEPAGE_TAB_TITLE = 'New tab'

/** How long to wait for an agent-opened tab's webview to attach: 20 × 150ms. */
const AGENT_TAB_ATTACH_ATTEMPTS = 20
const AGENT_TAB_ATTACH_POLL_MS = 150
const MINIMUM_WEBPAGE_SCAN_DURATION_MS = 10_000
/** A report drawer opens without its frozen page rather than wait longer than this for one. */
const PAGE_FREEZE_TIMEOUT_MS = 200
/** The frozen page outlives a closing drawer until the guest view is back on top of it. */
const PAGE_FREEZE_HOLD_MS = 400

type FrozenPage = { image: string; luminance: number }

function waitForMinimumScanDuration(startedAt: number) {
  const remainingTime = MINIMUM_WEBPAGE_SCAN_DURATION_MS - (performance.now() - startedAt)
  return remainingTime > 0
    ? new Promise<void>((resolve) => window.setTimeout(resolve, remainingTime))
    : Promise.resolve()
}

type BrowserTab = {
  id: string
  title: string
  url: string
  popupWebContentsId?: number
  favicon?: string
  isLoading?: boolean
}

type TabWebViewProps = ComponentPropsWithoutRef<typeof BrowserWebView> & {
  onHandle: (tabId: string, handle: BrowserWebViewHandle | null) => void
}

/**
 * One tab's guest view. It owns its ref callback so the callback (and therefore the imperative
 * handle handed to the shell) keeps its identity for the tab's lifetime, and it is memoized so a
 * shell render that does not concern this tab (a sidebar drag, another tab's title) skips it.
 */
const TabWebView = memo(function TabWebView({ onHandle, ...viewProps }: TabWebViewProps) {
  const { tabId } = viewProps
  const ref = useCallback((handle: BrowserWebViewHandle | null) => onHandle(tabId, handle), [onHandle, tabId])
  return <BrowserWebView ref={ref} {...viewProps} />
})

/** Patches one tab, returning the same array when nothing changes so React can skip the render. */
function patchTab(tabs: BrowserTab[], tabId: string, patch: Partial<BrowserTab>): BrowserTab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return tabs
  const current = tabs[index]
  if (!(Object.keys(patch) as Array<keyof BrowserTab>).some((key) => current[key] !== patch[key])) return tabs
  const next = tabs.slice()
  next[index] = { ...current, ...patch }
  return next
}

/** True from the first render `value` is true onward: mounts a lazy surface on first use, then keeps it. */
function useLatch(value: boolean): boolean {
  const [latched, setLatched] = useState(value)
  if (value && !latched) setLatched(true)
  return latched || value
}

function getTabTitle(url: string) {
  if (url === DEFAULT_BROWSER_URL) {
    return HOMEPAGE_TAB_TITLE
  }

  try {
    return new URL(url).hostname.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

/* The panel is a grid column, so its width has to stay wide enough to read and
   narrow enough to leave the page usable. */
const ASSISTANT_MIN_WIDTH = 320
const ASSISTANT_MAX_WIDTH = 760
const ASSISTANT_DEFAULT_WIDTH = 400
const ASSISTANT_WIDTH_STORAGE_KEY = 'promptguard.assistantWidth'

function clampAssistantWidth(width: number): number {
  // Never let the panel crowd the page out entirely on a small window.
  const upperBound = Math.max(
    ASSISTANT_MIN_WIDTH,
    Math.min(ASSISTANT_MAX_WIDTH, window.innerWidth - 420),
  )
  return Math.round(Math.min(Math.max(width, ASSISTANT_MIN_WIDTH), upperBound))
}

function readStoredAssistantWidth(): number {
  const stored = Number(window.localStorage.getItem(ASSISTANT_WIDTH_STORAGE_KEY))
  return Number.isFinite(stored) && stored > 0 ? clampAssistantWidth(stored) : ASSISTANT_DEFAULT_WIDTH
}

const BOOKMARKS_STORAGE_KEY = 'promptguard.bookmarks'

function readStoredBookmarks(): BookmarkItem[] {
  try {
    const stored = window.localStorage.getItem(BOOKMARKS_STORAGE_KEY)
    if (!stored) return []
    const parsed = JSON.parse(stored)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function getFaviconUrl(url: string, explicitFavicon?: string): string | null {
  const candidates = getFaviconCandidates(url, explicitFavicon)
  return candidates.length > 0 ? candidates[0] : null
}

function AsteriskTabIcon() {
  return <BrowserLogo size={14} className="tab-asterisk-icon" />
}

function TabFaviconContent({ url, favicon }: { url: string; favicon?: string }) {
  const [candidateIndex, setCandidateIndex] = useState(0)
  const candidates = getFaviconCandidates(url, favicon)
  const activeSrc = candidates[candidateIndex]

  if (!activeSrc || candidateIndex >= candidates.length) {
    return <AsteriskTabIcon />
  }

  return (
    <img
      src={activeSrc}
      alt=""
      className="tab-favicon-img"
      onError={() => setCandidateIndex((prev) => prev + 1)}
    />
  )
}

function TabIcon({ url, favicon }: { url: string; favicon?: string }) {
  return <TabFaviconContent key={`${url}::${favicon || ''}`} url={url} favicon={favicon} />
}

function TabSpinner() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" className="tab-spinner" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="rgba(255, 255, 255, 0.18)" />
      <path d="M12 3a9 9 0 0 1 9 9" stroke="#8ab4f8" />
    </svg>
  )
}

export function BrowserShell() {
  const webviewHandlesRef = useRef(new Map<string, BrowserWebViewHandle>())
  const loadingWatchdogsRef = useRef<Map<string, number>>(new Map())
  const nextTabId = useRef(2)
  const [tabs, setTabs] = useState<BrowserTab[]>([
    { id: 'tab-1', title: HOMEPAGE_TAB_TITLE, url: DEFAULT_BROWSER_URL, isLoading: false },
  ])
  const [activeTabId, setActiveTabId] = useState('tab-1')
  const [currentUrl, setCurrentUrl] = useState(DEFAULT_BROWSER_URL)
  const [addressValue, setAddressValue] = useState('')
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantWidth, setAssistantWidth] = useState(readStoredAssistantWidth)
  const [isResizingAssistant, setIsResizingAssistant] = useState(false)

  // Prompt and webpage analyses deliberately keep independent state. A benign
  // prompt must never replace or be displayed as the result of a webpage scan.
  const [promptDrawerOpen, setPromptDrawerOpen] = useState(false)
  const [promptDetails, setPromptDetails] = useState<AnalysisDetails | null>(null)
  const [webpageDrawerOpen, setWebpageDrawerOpen] = useState(false)
  const [webpageScanResult, setWebpageScanResult] = useState<SecurityCheckResponse | null>(null)
  const [webpageScanContent, setWebpageScanContent] = useState<WebpageContent | null>(null)
  const [isScanningPage, setIsScanningPage] = useState(false)
  // While a report drawer is open the guest view is hidden (a native view would
  // cover the drawer). A frame of the page, taken just before, stands in its
  // place, so the drawer's glass slides in over the page, not an empty window.
  const [frozenPage, setFrozenPage] = useState<FrozenPage | null>(null)
  const isReportDrawerOpen = promptDrawerOpen || webpageDrawerOpen
  const [isProviderSettingsOpen, setIsProviderSettingsOpen] = useState(false)
  const [activeTargetId, setActiveTargetId] = useState<number | null>(null)
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>(readStoredBookmarks)
  const [showBookmarksBar, setShowBookmarksBar] = useState(true)
  const [browserMenuOpen, setBrowserMenuOpen] = useState(false)
  const [activeDownloads, setActiveDownloads] = useState(0)
  const [browserActionError, setBrowserActionError] = useState('')

  const runBrowserAction = useCallback((action: Promise<unknown> | undefined) => {
    void action?.catch((error: unknown) => setBrowserActionError(error instanceof Error ? error.message : 'The browser action failed.'))
  }, [])

  const showBrowserPanel = useCallback((panel: BrowserPanel, anchor?: { x: number; y: number }) => {
    const targetId = webviewHandlesRef.current.get(activeTabId)?.getWebContentsId() ?? null
    runBrowserAction(window.electronAPI?.browserUI.show(panel, targetId, anchor))
  }, [activeTabId, runBrowserAction])

  useEffect(() => {
    const ui = window.electronAPI?.browserUI
    if (!ui) return
    const receive = (snapshot: Awaited<ReturnType<typeof ui.snapshot>>) => {
      setBookmarks(snapshot.bookmarks)
      setShowBookmarksBar(snapshot.settings.showBookmarksBar)
      setActiveDownloads(snapshot.downloads.filter((entry) => entry.state === 'progressing').length)
    }
    const unsubscribe = ui.onSnapshot(receive)
    const visibility = ui.onVisibility(setBrowserMenuOpen)
    const restoreFocus = ui.onRestoreFocus(() => document.querySelector<HTMLButtonElement>('.brave-menu-btn')?.focus())
    runBrowserAction(ui.importBookmarks(readStoredBookmarks()).then(() => ui.snapshot()).then(receive))
    return () => { unsubscribe(); visibility(); restoreFocus() }
  }, [runBrowserAction])

  useEffect(() => {
    if (window.electronAPI?.browserUI) return
    try {
      window.localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(bookmarks))
    } catch (err) {
      console.error('[bookmarks] failed to persist:', err)
    }
  }, [bookmarks])

  const handleAddBookmark = useCallback((title: string, url: string) => {
    const resolvedUrl = resolveNavigationUrl(url)
    if (window.electronAPI?.browserUI) { runBrowserAction(window.electronAPI.browserUI.saveBookmark({ title, url: resolvedUrl })); return }
    setBookmarks((prev) => {
      if (prev.some((b) => b.url === resolvedUrl)) return prev
      return [
        ...prev,
        {
          id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title,
          url: resolvedUrl,
          favicon: getFaviconUrl(resolvedUrl) || undefined,
          createdAt: Date.now(),
        },
      ]
    })
  }, [runBrowserAction])

  const handleEditBookmark = useCallback((id: string, title: string, url: string) => {
    const resolvedUrl = resolveNavigationUrl(url)
    if (window.electronAPI?.browserUI) { runBrowserAction(window.electronAPI.browserUI.saveBookmark({ id, title, url: resolvedUrl })); return }
    setBookmarks((prev) => prev.map((b) => (
      b.id === id ? { ...b, title, url: resolvedUrl, favicon: getFaviconUrl(resolvedUrl) || b.favicon } : b
    )))
  }, [runBrowserAction])

  const handleDeleteBookmark = useCallback((id: string) => {
    if (window.electronAPI?.browserUI) { runBrowserAction(window.electronAPI.browserUI.deleteBookmark(id)); return }
    setBookmarks((prev) => prev.filter((b) => b.id !== id))
  }, [runBrowserAction])

  const handleToggleBookmarkCurrentPage = useCallback(() => {
    if (!currentUrl || currentUrl === DEFAULT_BROWSER_URL) return
    const activeTab = tabs.find((t) => t.id === activeTabId)
    const activeTitle = activeTab?.title || HOMEPAGE_TAB_TITLE
    const activeFavicon = activeTab?.favicon || getFaviconUrl(currentUrl) || undefined

    if (window.electronAPI?.browserUI) {
      const existing = bookmarks.find((bookmark) => bookmark.url === currentUrl)
      runBrowserAction(existing ? window.electronAPI.browserUI.deleteBookmark(existing.id) : window.electronAPI.browserUI.saveBookmark({ title: activeTitle, url: currentUrl }))
      return
    }

    setBookmarks((prev) => {
      const existing = prev.find((b) => b.url === currentUrl)
      if (existing) {
        return prev.filter((b) => b.id !== existing.id)
      }
      return [
        ...prev,
        {
          id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title: activeTitle,
          url: currentUrl,
          favicon: activeFavicon,
          createdAt: Date.now(),
        },
      ]
    })
  }, [activeTabId, bookmarks, currentUrl, runBrowserAction, tabs])

  const isCurrentUrlBookmarked = bookmarks.some(
    (b) => b.url === currentUrl && currentUrl !== DEFAULT_BROWSER_URL
  )

  const updateTabUrl = useCallback((tabId: string, url: string, title?: string, favicon?: string) => {
    setTabs((previousTabs) => {
      const tab = previousTabs.find((item) => item.id === tabId)
      if (!tab) return previousTabs
      const nextTitle = title || (url === DEFAULT_BROWSER_URL ? HOMEPAGE_TAB_TITLE : getTabTitle(url))
      const domain = extractDomainForFavicon(url)
      const domainFavicon = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : undefined
      const nextFavicon = favicon || (url === tab.url ? tab.favicon : domainFavicon) || domainFavicon
      return patchTab(previousTabs, tabId, { title: nextTitle, url, favicon: nextFavicon })
    })
  }, [])

  const handleTabFaviconChange = useCallback((tabId: string, favicon: string) => {
    setTabs((previousTabs) => patchTab(previousTabs, tabId, { favicon }))
  }, [])

  const handleTabTitleChange = useCallback((tabId: string, title: string) => {
    setTabs((previousTabs) => patchTab(previousTabs, tabId, { title }))
  }, [])

  const handleWebViewLoadingChange = useCallback((tabId: string, loading: boolean) => {
    const existingTimer = loadingWatchdogsRef.current.get(tabId)
    if (existingTimer) {
      window.clearTimeout(existingTimer)
      loadingWatchdogsRef.current.delete(tabId)
    }

    setTabs((prev) => patchTab(prev, tabId, { isLoading: loading }))

    if (loading) {
      // Safety watchdog: ensure loading state never hangs permanently (e.g. background websockets/streaming)
      const timer = window.setTimeout(() => {
        loadingWatchdogsRef.current.delete(tabId)
        setTabs((prev) => patchTab(prev, tabId, { isLoading: false }))
      }, 8000)
      loadingWatchdogsRef.current.set(tabId, timer)
    }
  }, [])

  const handleReload = useCallback(() => {
    handleWebViewLoadingChange(activeTabId, true)
    webviewHandlesRef.current.get(activeTabId)?.reload()
  }, [activeTabId, handleWebViewLoadingChange])

  const handleStop = useCallback(() => {
    webviewHandlesRef.current.get(activeTabId)?.stop()
    handleWebViewLoadingChange(activeTabId, false)
  }, [activeTabId, handleWebViewLoadingChange])

  const handleNavigate = useCallback((url: string) => {
    let resolved: string
    try {
      resolved = resolveNavigationUrl(url)
    } catch {
      resolved = url
    }
    const domain = extractDomainForFavicon(resolved)
    const initialFavicon = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : undefined

    setCurrentUrl(resolved)
    setAddressValue(resolved === DEFAULT_BROWSER_URL ? '' : resolved)
    updateTabUrl(activeTabId, resolved, undefined, initialFavicon)
    handleWebViewLoadingChange(activeTabId, true)
    webviewHandlesRef.current.get(activeTabId)?.loadURL(resolved)
  }, [activeTabId, handleWebViewLoadingChange, updateTabUrl])

  const handleWebViewNavigate = useCallback((tabId: string, url: string) => {
    const domain = extractDomainForFavicon(url)
    const initialFavicon = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : undefined
    updateTabUrl(tabId, url, undefined, initialFavicon)
    if (tabId === activeTabId) {
      setCurrentUrl(url)
      setAddressValue(url === DEFAULT_BROWSER_URL ? '' : url)
    }
  }, [activeTabId, updateTabUrl])

  const handleWebViewSearch = useCallback((tabId: string, query: string) => {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`
    updateTabUrl(tabId, url)
    if (tabId === activeTabId) {
      setCurrentUrl(url)
      setAddressValue(url)
    }
    webviewHandlesRef.current.get(tabId)?.loadURL(url)
  }, [activeTabId, updateTabUrl])

  const getActiveWebviewHandle = useCallback(() => webviewHandlesRef.current.get(activeTabId) ?? null, [activeTabId])

  const setWebviewHandle = useCallback((tabId: string, handle: BrowserWebViewHandle | null) => {
    if (handle) {
      webviewHandlesRef.current.set(tabId, handle)
    } else {
      webviewHandlesRef.current.delete(tabId)
    }
  }, [])

  const handleSelectTab = useCallback((tab: BrowserTab) => {
    setActiveTabId(tab.id)
    setCurrentUrl(tab.url)
    setAddressValue(tab.url === DEFAULT_BROWSER_URL ? '' : tab.url)
  }, [])

  const handleNewTab = useCallback(() => {
    const tab: BrowserTab = {
      id: `tab-${nextTabId.current++}`,
      title: HOMEPAGE_TAB_TITLE,
      url: DEFAULT_BROWSER_URL,
    }

    setTabs((previousTabs) => [...previousTabs, tab])
    handleSelectTab(tab)
  }, [handleSelectTab])

  const handleOpenBookmarkInNewTab = useCallback((url: string) => {
    let resolved: string
    try {
      resolved = resolveNavigationUrl(url)
    } catch {
      resolved = url
    }
    const domain = extractDomainForFavicon(resolved)
    const initialFavicon = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : undefined

    const tab: BrowserTab = {
      id: `tab-${nextTabId.current++}`,
      title: resolved === DEFAULT_BROWSER_URL ? HOMEPAGE_TAB_TITLE : getTabTitle(resolved),
      url: resolved,
      favicon: initialFavicon,
    }
    setTabs((previousTabs) => [...previousTabs, tab])
    handleSelectTab(tab)
  }, [handleSelectTab])

  /**
   * Opens a tab on the agent's behalf and resolves to its Browser Runtime
   * target id.
   *
   * The runtime addresses tabs by webContents id, which does not exist until
   * main resolves the createTab IPC call — so the id is polled rather than read straight
   * after the state update, the same way the assistant resolves the active
   * target. Resolving to null lets the agent replan instead of driving a tab
   * that never appeared.
   */
  const handleAgentOpenTab = useCallback(async (url?: string): Promise<number | null> => {
    const tabUrl = url ? resolveNavigationUrl(url) : DEFAULT_BROWSER_URL
    const domain = extractDomainForFavicon(tabUrl)
    const initialFavicon = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : undefined

    const tab: BrowserTab = {
      id: `tab-${nextTabId.current++}`,
      title: tabUrl === DEFAULT_BROWSER_URL ? HOMEPAGE_TAB_TITLE : getTabTitle(tabUrl),
      url: tabUrl,
      favicon: initialFavicon,
    }

    setTabs((previousTabs) => [...previousTabs, tab])
    handleSelectTab(tab)

    for (let attempt = 0; attempt < AGENT_TAB_ATTACH_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => { window.setTimeout(resolve, AGENT_TAB_ATTACH_POLL_MS) })

      const targetId = webviewHandlesRef.current.get(tab.id)?.getWebContentsId() ?? null
      if (targetId !== null) {
        setActiveTargetId(targetId)
        return targetId
      }
    }

    return null
  }, [handleSelectTab])

  const handleCloseTab = useCallback((tabId: string) => {
    const tabIndex = tabs.findIndex((tab) => tab.id === tabId)

    if (tabs.length === 1) {
      if (window.electronAPI?.browserUI) { runBrowserAction(window.electronAPI.browserUI.closeWindow()); return }
      const replacementTab: BrowserTab = {
        id: `tab-${nextTabId.current++}`,
        title: HOMEPAGE_TAB_TITLE,
        url: DEFAULT_BROWSER_URL,
      }
      setTabs([replacementTab])
      handleSelectTab(replacementTab)
      return
    }

    const remainingTabs = tabs.filter((tab) => tab.id !== tabId)
    setTabs(remainingTabs)

    if (tabId === activeTabId) {
      handleSelectTab(remainingTabs[Math.max(0, tabIndex - 1)])
    }
  }, [activeTabId, handleSelectTab, runBrowserAction, tabs])

  useEffect(() => {
    const browser = window.electronAPI?.browser
    if (!browser) return undefined
    const stopPopupTab = browser.onPopupTab(({ webContentsId, url, disposition }) => {
      const tab: BrowserTab = {
        id: `tab-${nextTabId.current++}`,
        title: getTabTitle(url),
        url,
        popupWebContentsId: webContentsId,
      }
      setTabs((previousTabs) => [...previousTabs, tab])
      if (disposition !== 'background-tab') handleSelectTab(tab)
    })
    const stopPopupClosed = browser.onPopupClosed((webContentsId) => {
      const tab = tabs.find((item) => item.popupWebContentsId === webContentsId)
      if (tab) handleCloseTab(tab.id)
    })
    return () => {
      stopPopupTab()
      stopPopupClosed()
    }
  }, [handleCloseTab, handleSelectTab, tabs])

  // Call before opening a report drawer, while the guest is still on screen.
  const freezeActivePage = useCallback(async () => {
    const webContentsId = webviewHandlesRef.current.get(activeTabId)?.getWebContentsId() ?? null
    const captureFrame = window.electronAPI?.browser?.captureFrame
    if (webContentsId === null || !captureFrame) {
      setFrozenPage(null)
      return
    }
    const frame = await Promise.race([
      captureFrame(webContentsId).catch(() => null),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), PAGE_FREEZE_TIMEOUT_MS)),
    ])
    // No frame when the guest is not showing: on the home page (drawn by the
    // shell, so the drawer sees it anyway) or behind a drawer already open,
    // whose frozen frame is still current.
    if (frame) setFrozenPage(frame)
  }, [activeTabId])

  useEffect(() => {
    if (isReportDrawerOpen || isProviderSettingsOpen || !frozenPage) return undefined
    const timer = window.setTimeout(() => setFrozenPage(null), PAGE_FREEZE_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [isReportDrawerOpen, isProviderSettingsOpen, frozenPage])

  // The providers dialog is glass too, so it opens over a frozen page like the reports.
  const handleOpenSettings = useCallback(() => {
    void freezeActivePage().then(() => setIsProviderSettingsOpen(true))
  }, [freezeActivePage])
  const handleCloseSettings = useCallback(() => setIsProviderSettingsOpen(false), [])

  useEffect(() => window.electronAPI?.browserUI.onCommand(({ command, url }) => {
    if (command === 'new-tab') { if (url) handleOpenBookmarkInNewTab(url); else handleNewTab() }
    else if (command === 'bookmark-page') handleToggleBookmarkCurrentPage()
    else if (command === 'close-tab') handleCloseTab(activeTabId)
    else if (command === 'focus-address') {
      const input = document.querySelector<HTMLInputElement>('.address-input'); input?.focus(); input?.select()
    } else if (command === 'provider-settings') handleOpenSettings()
    else if (command === 'next-tab' || command === 'previous-tab') {
      const index = tabs.findIndex((tab) => tab.id === activeTabId)
      handleSelectTab(tabs[(index + (command === 'next-tab' ? 1 : tabs.length - 1)) % tabs.length])
    }
  }), [activeTabId, handleCloseTab, handleNewTab, handleOpenBookmarkInNewTab, handleOpenSettings, handleSelectTab, handleToggleBookmarkCurrentPage, tabs])

  const handleScanPage = useCallback(async () => {
    if (isScanningPage) return

    setIsScanningPage(true)
    const scanStartedAt = performance.now()
    try {
      const [content] = await Promise.all([
        extractPageContent(webviewHandlesRef.current.get(activeTabId) ?? null),
        freezeActivePage(),
      ])
      if (!content) {
        return
      }

      setWebpageScanContent(content)
      setWebpageScanResult(null)
      setPromptDrawerOpen(false)
      setWebpageDrawerOpen(true)

      const result = await checkWebpage(content)
      await waitForMinimumScanDuration(scanStartedAt)
      setWebpageScanResult(result)

    } catch (error) {
      console.error('[ScanPage] Failed:', error)
      setWebpageDrawerOpen(false)
    } finally {
      setIsScanningPage(false)
    }
  }, [activeTabId, freezeActivePage, isScanningPage])

  // The webview attaches asynchronously, so the id is polled while the
  // assistant is open rather than read once at mount.
  useEffect(() => {
    if (!assistantOpen) return undefined

    const readTargetId = () => {
      const nextId = webviewHandlesRef.current.get(activeTabId)?.getWebContentsId() ?? null
      setActiveTargetId((current) => (current === nextId ? current : nextId))
    }

    readTargetId()
    const intervalId = window.setInterval(readTargetId, 1000)
    return () => window.clearInterval(intervalId)
  }, [activeTabId, assistantOpen, currentUrl])

  const handleViewPromptDetails = useCallback(async (details: AnalysisDetails) => {
    setPromptDetails(details)
    await freezeActivePage()
    setWebpageDrawerOpen(false)
    setPromptDrawerOpen(true)
  }, [freezeActivePage])

  const handleClosePromptDrawer = useCallback(() => {
    setPromptDrawerOpen(false)
  }, [])

  const handleCloseWebpageDrawer = useCallback(() => {
    setWebpageDrawerOpen(false)
  }, [])

  const handleAssistantWidthChange = useCallback((width: number) => {
    setAssistantWidth(clampAssistantWidth(width))
  }, [])

  // Persisted after the drag rather than during it, so one resize is one write.
  useEffect(() => {
    if (isResizingAssistant) return
    window.localStorage.setItem(ASSISTANT_WIDTH_STORAGE_KEY, String(assistantWidth))
  }, [assistantWidth, isResizingAssistant])

  // A shrinking window can leave a stored width wider than the shell allows.
  useEffect(() => {
    const handleResize = () => setAssistantWidth((current) => clampAssistantWidth(current))
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Cleanup loading watchdog timers on unmount
  useEffect(() => {
    const watchdogs = loadingWatchdogsRef.current
    return () => {
      watchdogs.forEach((timer) => window.clearTimeout(timer))
      watchdogs.clear()
    }
  }, [])

  // Once the shell is idle: fetch the other surfaces' chunks, then mount the (closed) assistant
  // in a transition. Its first render is the expensive one; doing it here, time-sliced and
  // interruptible, keeps it off the shell's first frame and off the click that opens the panel.
  const [assistantWarm, setAssistantWarm] = useState(false)
  useEffect(() => {
    const idleId = window.requestIdleCallback(() => {
      void PromptAnalysisDetailsPanel.load()
      void WebpageAnalysisDetailsPanel.load()
      void ProviderSettingsModal.load()
      void AiAssistantSidebar.load().then(() => startTransition(() => setAssistantWarm(true)))
    }, { timeout: 2000 })
    return () => window.cancelIdleCallback(idleId)
  }, [])

  // Mounted once wanted and then kept, so a chat or a running agent task survives closing the panel.
  const assistantMounted = useLatch(assistantOpen || assistantWarm)
  const providerSettingsMounted = useLatch(isProviderSettingsOpen)

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const isCurrentTabLoading = Boolean(activeTab?.isLoading)

  return (
    <main
      className="browser-shell"
      style={frozenPage ? ({ '--page-luminance': frozenPage.luminance.toFixed(3) } as CSSProperties) : undefined}
    >
      {/* Tab Strip */}
      <div className="tab-strip" role="tablist" aria-label="Browser tabs">
        <div className="tab-strip-items">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              aria-selected={tab.id === activeTabId}
              className={`tab ${tab.id === activeTabId ? 'active-tab' : ''}`}
              onClick={() => handleSelectTab(tab)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  handleSelectTab(tab)
                }
              }}
              role="tab"
              tabIndex={tab.id === activeTabId ? 0 : -1}
            >
              {tab.isLoading ? (
                <TabSpinner />
              ) : (
                <TabIcon url={tab.url} favicon={tab.favicon} />
              )}
              <span className="tab-title">{tab.title}</span>
              <button
                className="tab-close-btn"
                type="button"
                aria-label={`Close ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation()
                  handleCloseTab(tab.id)
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button className="new-tab-btn" type="button" aria-label="New tab" onClick={handleNewTab}>+</button>
        </div>
        <div className="tab-strip-drag-region" aria-hidden="true" />
      </div>

      {/* Browser Frame */}
      <div className="browser-frame">
        <BrowserToolbar
          addressValue={addressValue}
          assistantOpen={assistantOpen}
          currentUrl={currentUrl}
          isLoading={isCurrentTabLoading}
          isScanning={isScanningPage}
          isBookmarked={isCurrentUrlBookmarked}
          onAddressChange={setAddressValue}
          onAssistantToggle={() => setAssistantOpen((isOpen) => !isOpen)}
          onBack={() => webviewHandlesRef.current.get(activeTabId)?.goBack()}
          onForward={() => webviewHandlesRef.current.get(activeTabId)?.goForward()}
          onNavigate={handleNavigate}
          onReload={handleReload}
          onStop={handleStop}
          onScanPage={handleScanPage}
          onToggleBookmark={handleToggleBookmarkCurrentPage}
          menuOpen={browserMenuOpen}
          activeDownloads={activeDownloads}
          onDownloadsOpen={() => showBrowserPanel('downloads')}
          onMenuOpen={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            showBrowserPanel('menu', { x: rect.right, y: rect.bottom + 8 })
          }}
        />
        {showBookmarksBar ? <BookmarkBar
          bookmarks={bookmarks}
          currentUrl={currentUrl}
          currentTitle={activeTab?.title || HOMEPAGE_TAB_TITLE}
          onNavigate={handleNavigate}
          onOpenInNewTab={handleOpenBookmarkInNewTab}
          onAddBookmark={handleAddBookmark}
          onEditBookmark={handleEditBookmark}
          onDeleteBookmark={handleDeleteBookmark}
        /> : null}
        <LoadingProgressBar isLoading={isCurrentTabLoading} />
        <div
          className={`content-grid ${assistantOpen ? 'content-grid--assistant-open' : ''} ${isResizingAssistant ? 'content-grid--resizing' : ''}`}
          style={{ '--assistant-width': `${assistantWidth}px` } as CSSProperties}
        >
          <div className="webview-stack">
            {tabs.map((tab) => (
              <TabWebView
                key={tab.id}
                onHandle={setWebviewHandle}
                initialUrl={tab.url}
                initialWebContentsId={tab.popupWebContentsId}
                isActive={tab.id === activeTabId}
                isObscured={promptDrawerOpen || webpageDrawerOpen || isProviderSettingsOpen || isResizingAssistant}
                tabId={tab.id}
                onLoadingChange={handleWebViewLoadingChange}
                onNavigate={handleWebViewNavigate}
                onFaviconChange={handleTabFaviconChange}
                onTitleChange={handleTabTitleChange}
                onSearch={handleWebViewSearch}
              />
            ))}
            {frozenPage ? <img className="webview-freeze" src={frozenPage.image} alt="" aria-hidden="true" draggable={false} /> : null}
          </div>
          <div
            className={`assistant-sidebar-container ${assistantOpen ? 'assistant-sidebar-container--open' : 'assistant-sidebar-container--closed'}`}
            aria-hidden={!assistantOpen}
          >
            {assistantMounted ? (
              <AiAssistantSidebar
                activeTargetId={activeTargetId}
                activeTabTitle={activeTab?.title}
                getActiveWebviewHandle={getActiveWebviewHandle}
                currentUrl={currentUrl}
                onOpenTab={handleAgentOpenTab}
                onResizingChange={setIsResizingAssistant}
                onViewDetails={handleViewPromptDetails}
                onWidthChange={handleAssistantWidthChange}
                width={assistantWidth}
                onOpenSettings={handleOpenSettings}
              />
            ) : null}
          </div>
        </div>
      </div>

      {browserActionError ? <div className="browser-action-error" role="alert">{browserActionError}<button type="button" onClick={() => setBrowserActionError('')}>Dismiss</button></div> : null}

      {/* These are separate reports and retain their own result state. Each panel already
          renders nothing until it has something to show, so it is only mounted from then on. */}
      {promptDetails ? (
        <PromptAnalysisDetailsPanel
          details={promptDetails}
          isOpen={promptDrawerOpen}
          onClose={handleClosePromptDrawer}
        />
      ) : null}
      {webpageScanContent ? (
        <WebpageAnalysisDetailsPanel
          content={webpageScanContent}
          isScanning={isScanningPage}
          result={webpageScanResult}
          isOpen={webpageDrawerOpen}
          onClose={handleCloseWebpageDrawer}
        />
      ) : null}
      {providerSettingsMounted ? (
        <ProviderSettingsModal
          isOpen={isProviderSettingsOpen}
          onClose={handleCloseSettings}
        />
      ) : null}
    </main>
  )
}
