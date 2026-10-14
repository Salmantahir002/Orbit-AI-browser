import { useState, type FormEvent, type MouseEvent } from 'react'
import { normalizeUrl } from '../services/urlUtils'
import { BrowserLogo } from './BrowserLogo'

type BrowserToolbarProps = {
  addressValue: string
  assistantOpen: boolean
  currentUrl: string
  isLoading: boolean
  isScanning: boolean
  isBookmarked?: boolean
  onAddressChange: (value: string) => void
  onAssistantToggle: () => void
  onBack: () => void
  onForward: () => void
  onNavigate: (url: string) => void
  onReload: () => void
  onStop?: () => void
  onScanPage: () => void
  onToggleBookmark?: () => void
  onMenuOpen: (event: MouseEvent<HTMLButtonElement>) => void
  menuOpen: boolean
  activeDownloads: number
  onDownloadsOpen: () => void
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  )
}

function ForwardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  )
}

function ReloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function SearchMagnifierIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function StarOutlineIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

function StarFilledIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="#8ab4f8" stroke="#8ab4f8" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}


function BraveMenuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  )
}

export function BrowserToolbar({
  addressValue,
  assistantOpen,
  isLoading,
  isScanning,
  isBookmarked = false,
  onAddressChange,
  onAssistantToggle,
  onBack,
  onForward,
  onNavigate,
  onReload,
  onStop,
  onScanPage,
  onToggleBookmark,
  onMenuOpen,
  menuOpen,
  activeDownloads,
  onDownloadsOpen,
}: BrowserToolbarProps) {
  const [errorMessage, setErrorMessage] = useState('')

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    try {
      const normalizedUrl = normalizeUrl(addressValue)
      setErrorMessage('')
      onNavigate(normalizedUrl)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Enter a valid URL')
    }
  }

  return (
    <div className="toolbar-row" aria-label="Browser toolbar">
      <nav className="toolbar-nav-group" aria-label="Navigation controls">
        <button className="nav-btn" type="button" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <button className="nav-btn" type="button" onClick={onForward} aria-label="Forward">
          <ForwardIcon />
        </button>
        <button
          className={`nav-btn ${isLoading ? 'nav-btn--loading' : ''}`}
          type="button"
          onClick={isLoading ? (onStop ?? onReload) : onReload}
          aria-label={isLoading ? 'Stop loading this page' : 'Reload this page'}
          title={isLoading ? 'Stop loading this page' : 'Reload this page'}
        >
          {isLoading ? <StopIcon /> : <ReloadIcon />}
        </button>
      </nav>

      <form className="address-form" onSubmit={handleSubmit}>
        <span className="omnibox-search-icon" aria-hidden="true">
          <SearchMagnifierIcon />
        </span>
        <input
          aria-label="Address and search bar"
          className="address-input"
          spellCheck={false}
          placeholder="Search Google or type a URL"
          value={addressValue}
          onChange={(event) => onAddressChange(event.target.value)}
        />
        {onToggleBookmark ? (
          <button
            type="button"
            className={`omnibox-star-btn ${isBookmarked ? 'omnibox-star-btn--active' : ''}`}
            onClick={onToggleBookmark}
            title={isBookmarked ? 'Bookmark added for this tab' : 'Bookmark this tab'}
            aria-label={isBookmarked ? 'Remove bookmark' : 'Bookmark this tab'}
          >
            {isBookmarked ? <StarFilledIcon /> : <StarOutlineIcon />}
          </button>
        ) : null}
      </form>

      <div className="toolbar-actions-group">
        {activeDownloads > 0 ? (
          <button className="nav-btn toolbar-download-indicator" type="button" onClick={onDownloadsOpen} aria-label={`Downloads: ${activeDownloads} active`} title="Downloads">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5" /></svg>
            <span>{activeDownloads}</span>
          </button>
        ) : null}
        <button
          className={`scan-button ${isScanning ? 'scan-button--scanning' : ''}`}
          type="button"
          onClick={onScanPage}
          disabled={isScanning}
          title="Scan page for prompt injection attacks"
          aria-label="Scan page"
        >
          <ShieldIcon />
          <span>{isScanning ? 'Scanning...' : 'Scan'}</span>
        </button>

        <button
          className={`assistant-pill ${assistantOpen ? 'assistant-pill--active' : ''}`}
          type="button"
          aria-label="Toggle AI Agent"
          aria-pressed={assistantOpen}
          onClick={onAssistantToggle}
          title="Toggle AI Agent"
        >
          <BrowserLogo size={14} />
          <span>Ai Agent</span>
        </button>

        <button
          className="brave-menu-btn"
          type="button"
          aria-label="Customize and control browser"
          title="Customize and control browser"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={onMenuOpen}
        >
          <BraveMenuIcon />
        </button>
      </div>

      {errorMessage ? <div className="toolbar-error" role="alert">{errorMessage}</div> : null}
    </div>
  )
}
