import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type FormEvent } from 'react'
import type { WebpageContent } from '../types/securityTypes'
import { BrowserLogo } from './BrowserLogo'
import { LiquidGlass } from './LiquidGlass'

export type BrowserWebViewHandle = {
  extractContent: () => Promise<WebpageContent | null>
  /** Browser Runtime target id for this tab; null before the webview attaches. */
  getWebContentsId: () => number | null
  goBack: () => void
  goForward: () => void
  loadURL: (url: string) => void
  reload: () => void
  stop: () => void
}

type BrowserWebViewProps = {
  initialUrl: string
  initialWebContentsId?: number
  isActive: boolean
  /** True while a drawer/modal must paint over this tab, or a drag (e.g. the assistant
   *  panel resize) must not have its pointer events swallowed by the guest content. */
  isObscured?: boolean
  tabId: string
  onLoadingChange: (tabId: string, isLoading: boolean) => void
  onNavigate: (tabId: string, url: string) => void
  onFaviconChange?: (tabId: string, favicon: string) => void
  onTitleChange?: (tabId: string, title: string) => void
  onSearch: (tabId: string, query: string) => void
}

const HOMEPAGE_URL = 'about:blank'

type HomePageProps = {
  onSearch: (query: string) => void
  zoom?: number
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  )
}

function HomePage({ onSearch, zoom = 100 }: HomePageProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [suggestionResult, setSuggestionResult] = useState({
    query: '',
    suggestions: [] as string[],
  })

  useEffect(() => {
    if (isSearchOpen) {
      inputRef.current?.focus()
    }
  }, [isSearchOpen])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!query) {
      return undefined
    }

    const controller = new AbortController()
    const requestId = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`,
          { signal: controller.signal },
        )
        const data: unknown = await response.json()
        const nextSuggestions = Array.isArray(data) && Array.isArray(data[1])
          ? data[1].filter((item): item is string => typeof item === 'string').slice(0, 5)
          : []
        setSuggestionResult({ query, suggestions: nextSuggestions })
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setSuggestionResult({ query, suggestions: [] })
        }
      }
    }, 180)

    return () => {
      controller.abort()
      window.clearTimeout(requestId)
    }
  }, [searchQuery])

  const fallbackSuggestions = searchQuery.trim()
    ? [searchQuery.trim(), `${searchQuery.trim()} news`, `${searchQuery.trim()} latest`]
    : []
  const visibleSuggestions = suggestionResult.query === searchQuery.trim() && suggestionResult.suggestions.length > 0
    ? suggestionResult.suggestions
    : fallbackSuggestions

  function submitSearch(query = searchQuery) {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) {
      return
    }

    onSearch(trimmedQuery)
    setIsSearchOpen(false)
  }

  function dismissSearch() {
    setIsSearchOpen(false)
    setSearchQuery('')
    setSuggestionResult({ query: '', suggestions: [] })
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    submitSearch()
  }

  return (
    <div className={`homepage-message ${isSearchOpen ? 'homepage-message--search-open' : ''}`} style={{ zoom: zoom / 100 }}>
      <div className="homepage-content">
        <div className="homepage-hero">
          <div className="homepage-hero-icon-wrap">
            <BrowserLogo size={70} className="homepage-hero-logo" />
          </div>
          <h1 className="homepage-hero-title">orbit</h1>
          <p className="homepage-hero-subtitle">A BROWSER FOR AGENTIC SEARCH WITH PROMPT DEFENSE</p>
        </div>
        <button className="homepage-start-button lg-host" type="button" onClick={() => setIsSearchOpen(true)}>
          <LiquidGlass refraction={44} bezel={14} blur={5} aberration={0} elasticity={0.16} />
          Start browsing
          <ArrowIcon />
        </button>
      </div>

      {isSearchOpen ? (
        <button
          className="homepage-search-backdrop"
          type="button"
          aria-label="Close search"
          onClick={dismissSearch}
        />
      ) : null}

      {isSearchOpen ? (
        <div className="homepage-search-popup" role="dialog" aria-modal="true" aria-label="Search Google">
          <form onSubmit={handleSubmit}>
            <SearchIcon />
            <input
              ref={inputRef}
              aria-autocomplete="list"
              aria-controls="homepage-search-suggestions"
              aria-expanded={visibleSuggestions.length > 0}
              autoComplete="off"
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  dismissSearch()
                }
              }}
              placeholder="Search anything"
              value={searchQuery}
            />
            <button className="homepage-search-submit" type="submit" aria-label="Search Google">
              <ArrowIcon />
            </button>
          </form>
          {visibleSuggestions.length > 0 ? (
            <div className="homepage-suggestions" id="homepage-search-suggestions" role="listbox">
              {visibleSuggestions.map((suggestion) => (
                <button key={suggestion} type="button" role="option" onClick={() => submitSearch(suggestion)}>
                  <SearchIcon />
                  <span>{suggestion}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export const BrowserWebView = forwardRef<BrowserWebViewHandle, BrowserWebViewProps>(
  function BrowserWebView({
    initialUrl,
    initialWebContentsId,
    isActive,
    isObscured = false,
    tabId,
    onLoadingChange,
    onNavigate,
    onFaviconChange,
    onTitleChange,
    onSearch,
  }, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const webContentsIdRef = useRef<number | null>(initialWebContentsId ?? null)
    const popupMountGenerationRef = useRef(0)
    // The tab is created once, at mount, from this URL. Subsequent navigation
    // always goes through loadURL().
    const webviewInitialUrlRef = useRef(initialUrl)
    const [activeUrl, setActiveUrl] = useState(initialUrl)
    const [errorMessage, setErrorMessage] = useState('')
    const [homepageZoom, setHomepageZoom] = useState(100)
    const isElectronRuntime = Boolean(window.electronAPI)
    const isHomePage = activeUrl === HOMEPAGE_URL && initialWebContentsId === undefined

    // The guest content is a native view main composites on top of this whole
    // window — nothing in our own DOM can paint over it with CSS. Whenever
    // something needs to show instead (the New Tab UI, a load error, a
    // drawer/modal, or an inactive tab), we hide the guest by shrinking it to
    // zero size rather than trying to layer on top of it.
    const shouldShowGuest = isActive && !isHomePage && !errorMessage && !isObscured
    const isActiveRef = useRef(isActive)
    const shouldShowGuestRef = useRef(shouldShowGuest)
    useEffect(() => {
      shouldShowGuestRef.current = shouldShowGuest
    }, [shouldShowGuest])

    // Re-arming the ResizeObserver (every show/hide toggle) fires it once immediately, and a
    // resize can settle on the rect it started from. Identical bounds are not worth an IPC message.
    const lastSentBoundsRef = useRef('')
    const pushBounds = useCallback(() => {
      const webContentsId = webContentsIdRef.current
      const container = containerRef.current
      if (webContentsId === null || !container || !window.electronAPI) return

      let bounds = { x: 0, y: 0, width: 0, height: 0 }
      if (shouldShowGuestRef.current) {
        const rect = container.getBoundingClientRect()
        bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }

      const key = `${webContentsId}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
      if (key === lastSentBoundsRef.current) return
      lastSentBoundsRef.current = key
      window.electronAPI.browser.setBounds(webContentsId, bounds)
    }, [])

    useEffect(() => {
      isActiveRef.current = isActive
      if (!isActive || !isElectronRuntime) return
      const activate = () => {
        const id = webContentsIdRef.current
        if (id !== null) window.electronAPI?.browser.setActiveTab(id)
      }
      activate()
      const timer = window.setTimeout(activate, 200)
      return () => window.clearTimeout(timer)
    }, [isActive, isElectronRuntime])

    useImperativeHandle(ref, () => ({
      extractContent: async () => {
        const webContentsId = webContentsIdRef.current
        if (webContentsId === null) return null
        try {
          const result = await window.electronAPI?.scanWebview(webContentsId)
          return (result as WebpageContent) ?? null
        } catch {
          return null
        }
      },
      getWebContentsId: () => webContentsIdRef.current,
      goBack: () => {
        const webContentsId = webContentsIdRef.current
        if (webContentsId !== null) window.electronAPI?.browser.goBack(webContentsId)
      },
      goForward: () => {
        const webContentsId = webContentsIdRef.current
        if (webContentsId !== null) window.electronAPI?.browser.goForward(webContentsId)
      },
      loadURL: (url: string) => {
        setErrorMessage('')
        setActiveUrl(url)
        const webContentsId = webContentsIdRef.current
        if (webContentsId !== null) {
          window.electronAPI?.browser.navigate(webContentsId, url).catch((err: unknown) => {
            console.error('[browser] navigate failed:', err)
          })
        }
      },
      reload: () => {
        const webContentsId = webContentsIdRef.current
        if (webContentsId !== null) window.electronAPI?.browser.reload(webContentsId)
      },
      stop: () => {
        const webContentsId = webContentsIdRef.current
        if (webContentsId !== null) window.electronAPI?.browser.stop(webContentsId)
      },
    }), [])

    // Creates this tab's guest view in main on mount, tears it down on unmount.
    // Runs once per component instance — a tab never changes which guest it owns.
    useEffect(() => {
      if (!isElectronRuntime) return undefined
      let cancelled = false

      if (initialWebContentsId !== undefined) {
        const generationRef = popupMountGenerationRef
        const generation = ++generationRef.current
        containerRef.current?.setAttribute('data-webcontents-id', String(initialWebContentsId))
        pushBounds()
        return () => {
          cancelled = true
          queueMicrotask(() => {
            if (generationRef.current === generation) {
              void window.electronAPI?.browser.closeTab(initialWebContentsId)
            }
          })
        }
      }

      // StrictMode (dev) runs this effect, cleans it up, and runs it again within one synchronous
      // pass. Asking main for the view in a microtask lets that first, already-cancelled run bail
      // out before it requests anything, so a tab is one WebContentsView and not one that is
      // created and immediately destroyed (which logged a burst of CDP "target closed" errors).
      queueMicrotask(() => {
        if (cancelled) return
        window.electronAPI!.browser.createTab(webviewInitialUrlRef.current).then((result) => {
          if (!result) return
          if (cancelled) {
            // Closed while main was still creating it.
            void window.electronAPI?.browser.closeTab(result.webContentsId)
            return
          }
          webContentsIdRef.current = result.webContentsId
          setHomepageZoom(result.zoom)
          if (isActiveRef.current) window.electronAPI?.browser.setActiveTab(result.webContentsId)
          containerRef.current?.setAttribute('data-webcontents-id', String(result.webContentsId))
          pushBounds()
        })
      })

      return () => {
        cancelled = true
        const webContentsId = webContentsIdRef.current
        if (webContentsId !== null) void window.electronAPI?.browser.closeTab(webContentsId)
      }
    }, [initialWebContentsId, isElectronRuntime, pushBounds])

    useEffect(() => {
      if (initialWebContentsId === undefined) return undefined
      let cancelled = false
      window.electronAPI?.browser.getTabInfo(initialWebContentsId).then((info) => {
        if (cancelled || !info) return
        setActiveUrl(info.url)
        onNavigate(tabId, info.url)
        if (info.title) onTitleChange?.(tabId, info.title)
      })
      return () => { cancelled = true }
    }, [initialWebContentsId, onNavigate, onTitleChange, tabId])

    // Keeps the guest's bounds in sync with this container's on-screen rect —
    // window resizes, the assistant panel opening, and active/obscured toggles
    // all reflow it.
    useEffect(() => {
      if (!isElectronRuntime) return undefined
      pushBounds()

      const container = containerRef.current
      if (!container) return undefined
      const observer = new ResizeObserver(pushBounds)
      observer.observe(container)
      return () => observer.disconnect()
    }, [isElectronRuntime, shouldShowGuest, pushBounds])

    useEffect(() => {
      if (!isElectronRuntime) return undefined

      return window.electronAPI!.browser.onTabEvent((event) => {
        if (event.webContentsId !== webContentsIdRef.current) return

        switch (event.type) {
          case 'zoom-changed':
            if (typeof event.zoom === 'number') setHomepageZoom(event.zoom)
            break
          case 'did-start-loading':
            onLoadingChange(tabId, true)
            break
          case 'did-stop-loading':
          case 'did-finish-load':
            onLoadingChange(tabId, false)
            break
          case 'did-navigate':
          case 'did-navigate-in-page':
            if (event.url) {
              setActiveUrl(event.url)
              onNavigate(tabId, event.url)
            }
            break
          case 'page-favicon-updated':
            if (event.favicon) {
              onFaviconChange?.(tabId, event.favicon)
            }
            break
          case 'page-title-updated':
            if (event.title) {
              onTitleChange?.(tabId, event.title)
            }
            break
          case 'did-fail-load':
            if (event.errorCode === -3) break // aborted by a subsequent navigation
            setErrorMessage(event.errorDescription ?? 'Page failed to load')
            onLoadingChange(tabId, false)
            break
        }
      })
    }, [isElectronRuntime, onFaviconChange, onLoadingChange, onNavigate, onTitleChange, tabId])

    if (!isElectronRuntime) {
      return (
        <section className={`webview-stage ${isActive ? '' : 'webview-stage--inactive'}`} aria-hidden={!isActive} aria-label="Browser web view">
          <iframe className="browser-iframe" src={activeUrl} title="Browser preview" />
          {isHomePage ? <HomePage zoom={homepageZoom} onSearch={(query) => onSearch(tabId, query)} /> : null}
          {!isHomePage ? <div className="webview-note">Electron webview activates inside desktop app.</div> : null}
        </section>
      )
    }

    return (
      <section className={`webview-stage ${isActive ? '' : 'webview-stage--inactive'}`} aria-hidden={!isActive} aria-label="Browser web view">
        {/* Empty on purpose: the actual page is a WebContentsView main composites
            over this rect (see pushBounds above), not a child of this DOM tree. */}
        <div ref={containerRef} className="browser-webview" />
        {isHomePage ? <HomePage zoom={homepageZoom} onSearch={(query) => onSearch(tabId, query)} /> : null}
        {errorMessage ? <div className="webview-error" role="alert">{errorMessage}</div> : null}
      </section>
    )
  },
)
