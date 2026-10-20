import { memo, useState, useRef, useEffect, useCallback, type MouseEvent } from 'react'
import type { BookmarkItem } from '../types/bookmarkTypes'
import { getFaviconCandidates, resolveNavigationUrl } from '../services/urlUtils'

type BookmarkBarProps = {
  bookmarks: BookmarkItem[]
  currentUrl: string
  currentTitle: string
  onNavigate: (url: string) => void
  onOpenInNewTab: (url: string) => void
  onAddBookmark: (title: string, url: string) => void
  onEditBookmark: (id: string, title: string, url: string) => void
  onDeleteBookmark: (id: string) => void
}


function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

function ChevronRightDoubleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" aria-hidden="true">
      <polyline points="13 17 18 12 13 7" />
      <polyline points="6 17 11 12 6 7" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function BookmarkFaviconContent({ url, favicon }: { url: string; favicon?: string }) {
  const [candidateIndex, setCandidateIndex] = useState(0)
  const candidates = getFaviconCandidates(url, favicon)
  const activeSrc = candidates[candidateIndex]

  if (!activeSrc || candidateIndex >= candidates.length) {
    return <GlobeIcon />
  }

  return (
    <img
      src={activeSrc}
      alt=""
      className="bookmark-favicon"
      onError={() => setCandidateIndex((prev) => prev + 1)}
    />
  )
}

function BookmarkFavicon({ url, favicon }: { url: string; favicon?: string }) {
  return <BookmarkFaviconContent key={`${url}::${favicon || ''}`} url={url} favicon={favicon} />
}

// Memoized: the shell re-renders for tab loading/title/favicon changes and sidebar drags, and the
// bar's props (all stable callbacks plus the bookmark list) do not change with any of them.
export const BookmarkBar = memo(function BookmarkBar({
  bookmarks,
  currentUrl,
  currentTitle,
  onNavigate,
  onOpenInNewTab,
  onAddBookmark,
  onEditBookmark,
  onDeleteBookmark,
}: BookmarkBarProps) {
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean
    x: number
    y: number
    bookmarkId?: string
  }>({ visible: false, x: 0, y: 0 })

  const [dialogState, setDialogState] = useState<{
    open: boolean
    mode: 'add' | 'edit'
    bookmarkId?: string
    title: string
    url: string
  }>({ open: false, mode: 'add', title: '', url: '' })

  const [overflowOpen, setOverflowOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Dismiss context menu on outside click or escape
  useEffect(() => {
    if (!contextMenu.visible) return undefined

    const handleClickOutside = (event: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setContextMenu({ visible: false, x: 0, y: 0 })
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu({ visible: false, x: 0, y: 0 })
        setOverflowOpen(false)
      }
    }

    window.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [contextMenu.visible])

  const handleBarContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    setContextMenu({
      visible: true,
      x: event.clientX,
      y: event.clientY,
    })
  }, [])

  const handleBookmarkContextMenu = useCallback((event: MouseEvent<HTMLButtonElement>, id: string) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      bookmarkId: id,
    })
  }, [])

  const openAddDialog = useCallback((defaultTitle = currentTitle, defaultUrl = currentUrl) => {
    setDialogState({
      open: true,
      mode: 'add',
      title: defaultTitle || 'New Bookmark',
      url: defaultUrl && defaultUrl !== 'about:blank' ? defaultUrl : 'https://',
    })
    setContextMenu({ visible: false, x: 0, y: 0 })
  }, [currentTitle, currentUrl])

  const openEditDialog = useCallback((id: string) => {
    const target = bookmarks.find((item) => item.id === id)
    if (!target) return
    setDialogState({
      open: true,
      mode: 'edit',
      bookmarkId: id,
      title: target.title,
      url: target.url,
    })
    setContextMenu({ visible: false, x: 0, y: 0 })
  }, [bookmarks])

  const handleSaveDialog = useCallback((event: React.FormEvent) => {
    event.preventDefault()
    const trimmedTitle = dialogState.title.trim() || 'Untitled'
    const trimmedUrl = dialogState.url.trim()
    const resolvedUrl = resolveNavigationUrl(trimmedUrl)

    if (dialogState.mode === 'add') {
      onAddBookmark(trimmedTitle, resolvedUrl)
    } else if (dialogState.bookmarkId) {
      onEditBookmark(dialogState.bookmarkId, trimmedTitle, resolvedUrl)
    }

    setDialogState({ open: false, mode: 'add', title: '', url: '' })
  }, [dialogState, onAddBookmark, onEditBookmark])

  const selectedBookmark = contextMenu.bookmarkId
    ? bookmarks.find((b) => b.id === contextMenu.bookmarkId)
    : null

  return (
    <div
      className="bookmark-bar"
      onContextMenu={handleBarContextMenu}
      role="toolbar"
      aria-label="Bookmarks bar"
    >
      <div className="bookmark-items-container">
        {bookmarks.length === 0 ? (
          <div className="bookmark-empty-hint">
            <button
              className="bookmark-add-hint-btn"
              type="button"
              onClick={() => openAddDialog()}
            >
              <PlusIcon />
              <span>Add bookmark</span>
            </button>
          </div>
        ) : (
          bookmarks.map((bookmark) => (
            <button
              key={bookmark.id}
              className="bookmark-item-btn"
              type="button"
              title={`${bookmark.title} (${bookmark.url})`}
              onClick={() => onNavigate(resolveNavigationUrl(bookmark.url))}
              onContextMenu={(event) => handleBookmarkContextMenu(event, bookmark.id)}
            >
              <span className="bookmark-icon">
                <BookmarkFavicon url={bookmark.url} favicon={bookmark.favicon} />
              </span>
              <span className="bookmark-title">{bookmark.title}</span>
            </button>
          ))
        )}
      </div>

      <div className="bookmark-bar-fixed-right">
        <button
          className="bookmark-overflow-btn"
          type="button"
          title="Other bookmarks"
          aria-label="Other bookmarks"
          onClick={() => setOverflowOpen((prev) => !prev)}
        >
          <ChevronRightDoubleIcon />
        </button>
      </div>

      {/* Context Menu */}
      {contextMenu.visible ? (
        <div
          ref={menuRef}
          className="bookmark-context-menu"
          style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
          role="menu"
        >
          {selectedBookmark ? (
            <>
              <button
                type="button"
                className="bookmark-context-item"
                onClick={() => {
                  onNavigate(resolveNavigationUrl(selectedBookmark.url))
                  setContextMenu({ visible: false, x: 0, y: 0 })
                }}
              >
                Open
              </button>
              <button
                type="button"
                className="bookmark-context-item"
                onClick={() => {
                  onOpenInNewTab(resolveNavigationUrl(selectedBookmark.url))
                  setContextMenu({ visible: false, x: 0, y: 0 })
                }}
              >
                Open in new tab
              </button>
              <div className="bookmark-context-separator" />
              <button
                type="button"
                className="bookmark-context-item"
                onClick={() => openEditDialog(selectedBookmark.id)}
              >
                Edit...
              </button>
              <button
                type="button"
                className="bookmark-context-item bookmark-context-danger"
                onClick={() => {
                  onDeleteBookmark(selectedBookmark.id)
                  setContextMenu({ visible: false, x: 0, y: 0 })
                }}
              >
                Delete
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="bookmark-context-item"
                onClick={() => openAddDialog()}
              >
                Add page to bookmarks...
              </button>
              <button
                type="button"
                className="bookmark-context-item"
                onClick={() => openAddDialog('New Bookmark', 'https://')}
              >
                Add new bookmark...
              </button>
            </>
          )}
        </div>
      ) : null}

      {/* Overflow Menu */}
      {overflowOpen ? (
        <div className="bookmark-overflow-menu" role="menu">
          {bookmarks.length === 0 ? (
            <div className="bookmark-overflow-empty">No bookmarks yet</div>
          ) : (
            bookmarks.map((bm) => (
              <button
                key={`overflow-${bm.id}`}
                type="button"
                className="bookmark-overflow-item"
                onClick={() => {
                  onNavigate(resolveNavigationUrl(bm.url))
                  setOverflowOpen(false)
                }}
              >
                <span className="bookmark-icon">
                  <BookmarkFavicon url={bm.url} favicon={bm.favicon} />
                </span>
                <span className="bookmark-overflow-title">{bm.title}</span>
              </button>
            ))
          )}
        </div>
      ) : null}

      {/* Add / Edit Bookmark Modal Dialog */}
      {dialogState.open ? (
        <div className="bookmark-modal-backdrop" onClick={() => setDialogState((s) => ({ ...s, open: false }))}>
          <div
            ref={dialogRef}
            className="bookmark-modal-dialog"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bookmark-modal-title"
          >
            <div className="bookmark-modal-header">
              <h3 id="bookmark-modal-title">
                {dialogState.mode === 'add' ? 'Add Bookmark' : 'Edit Bookmark'}
              </h3>
              <button
                type="button"
                className="bookmark-modal-close"
                onClick={() => setDialogState((s) => ({ ...s, open: false }))}
                aria-label="Close dialog"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSaveDialog} className="bookmark-modal-form">
              <label className="bookmark-modal-label">
                Name
                <input
                  type="text"
                  className="bookmark-modal-input"
                  value={dialogState.title}
                  onChange={(e) => setDialogState((s) => ({ ...s, title: e.target.value }))}
                  required
                  autoFocus
                />
              </label>
              <label className="bookmark-modal-label">
                URL
                <input
                  type="text"
                  className="bookmark-modal-input"
                  value={dialogState.url}
                  onChange={(e) => setDialogState((s) => ({ ...s, url: e.target.value }))}
                  required
                />
              </label>
              <div className="bookmark-modal-actions">
                <button
                  type="button"
                  className="bookmark-modal-btn bookmark-modal-btn-cancel"
                  onClick={() => setDialogState((s) => ({ ...s, open: false }))}
                >
                  Cancel
                </button>
                <button type="submit" className="bookmark-modal-btn bookmark-modal-btn-save">
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  )
})
