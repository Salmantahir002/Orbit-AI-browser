import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'framer-motion'
import { ArrowDownToLine, ArrowUpRight, Bookmark as BookmarkIcon, Check, ChevronRight, CircleArrowUp, CircleCheck, Download, ExternalLink, File, FolderOpen, Globe, History, Info, LoaderCircle, Maximize, Minus, MoreHorizontal, PanelTop, Pause, Pencil, Play, Plus, Printer, RefreshCw, RotateCcw, RotateCw, Search, Settings, Shield, SquareArrowOutUpRight, Trash2, X, LogOut } from 'lucide-react'
import type { Bookmark, BrowserPanel, BrowserSnapshot, BrowserUIBridge, ClearDataRequest, DownloadEntry, OverlayState, UpdateState } from '../../electron/browserUITypes'
import { ZOOM_LEVELS } from '../../electron/browserUITypes'
import { BrowserLogo } from './BrowserLogo'
import { SiteControlsPopup } from './SiteControlsPopup'
import '../styles/browser-panels.css'

type Actions = { ui: BrowserUIBridge; run: (action: () => Promise<unknown>, success?: string) => Promise<boolean>; navigate: (url: string) => void; show: (panel: BrowserPanel) => void }

function IconButton({ label, children, onClick, disabled = false }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button className="bp-icon-button" type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>
}

function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: string }) {
  return <div className="bp-setting-row"><div><span className="bp-setting-title">{label}</span>{description ? <p>{description}</p> : null}</div><button type="button" className="bp-switch" role="switch" aria-label={label} aria-checked={checked} onClick={() => onChange(!checked)}><span /></button></div>
}

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <div className="bp-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label={placeholder} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />{value ? <IconButton label="Clear search" onClick={() => onChange('')}><X size={14} /></IconButton> : null}</div>
}

function EmptyState({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return <div className="bp-empty"><div>{icon}</div><h3>{title}</h3><p>{description}</p></div>
}

function MenuItem({ icon, children, shortcut, onSelect, disabled = false, className = '' }: { icon: ReactNode; children: ReactNode; shortcut?: string; onSelect: () => void; disabled?: boolean; className?: string }) {
  return <Menu.Item className={`bp-menu-item ${className}`} disabled={disabled} onSelect={(event) => { event.preventDefault(); onSelect() }}>{icon}<span>{children}</span>{shortcut ? <kbd>{shortcut}</kbd> : null}</Menu.Item>
}

function preserveSubmenuPointerTransfer(event: PointerEvent<HTMLDivElement>) {
  // A fast pointer can enter the portaled submenu in one event, without crossing the
  // parent's grace triangle. Keep focus in that branch instead of refocusing the parent.
  const next = event.relatedTarget
  if (next instanceof Element && next.closest('.bp-submenu')?.id === event.currentTarget.getAttribute('aria-controls')) event.preventDefault()
}

function BrowserMenu({ state, snapshot, update, actions, closeAction }: { state: OverlayState; snapshot: BrowserSnapshot; update: UpdateState | null; actions: Actions; closeAction: (action?: () => Promise<unknown>) => void }) {
  const { ui, run, show, navigate } = actions
  const currentIsBookmarked = snapshot.bookmarks.some((entry) => entry.url === state.url)
  const updateLabel = update?.status === 'downloaded' ? 'Restart to update Orbit' : update?.status === 'downloading' ? 'Downloading update…' : update?.status === 'available' ? 'Update Orbit' : null
  const menuPosition = { left: Math.min(window.innerWidth - 12, Math.max(320, state.anchor.x)), top: Math.max(4, Math.min(window.innerHeight - 440, state.anchor.y)) }
  return <Menu.Root open onOpenChange={(open) => { if (!open) closeAction() }} modal>
    <Menu.Trigger className="bp-menu-anchor" style={menuPosition} aria-label="Browser menu anchor" tabIndex={-1} />
    <Menu.Portal>
      <Menu.Content asChild forceMount align="end" side="bottom" sideOffset={0} collisionPadding={10} onCloseAutoFocus={(event) => event.preventDefault()}>
        <motion.div className="bp-menu" aria-label="Customize and control Orbit" initial={{ opacity: 0, scale: 0.94, y: -8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: -4 }} transition={{ type: 'spring', stiffness: 480, damping: 34 }}>
          {updateLabel ? <><MenuItem className="bp-menu-update" icon={<CircleArrowUp />} onSelect={() => show('about')}>{updateLabel}</MenuItem><Menu.Separator className="bp-separator" /></> : null}
          <Menu.Group>
            <MenuItem icon={<PanelTop />} shortcut="Ctrl+T" onSelect={() => closeAction(() => ui.command('new-tab'))}>New tab</MenuItem>
            <MenuItem icon={<SquareArrowOutUpRight />} shortcut="Ctrl+N" onSelect={() => closeAction(() => ui.newWindow())}>New window</MenuItem>
          </Menu.Group>
          <Menu.Separator className="bp-separator" />
          <Menu.Group>
            <Menu.Sub>
              <Menu.SubTrigger className="bp-menu-item" onPointerLeave={preserveSubmenuPointerTransfer}><History /><span>History</span><ChevronRight className="bp-chevron" /></Menu.SubTrigger>
              <Menu.Portal><Menu.SubContent className="bp-submenu" sideOffset={8} collisionPadding={10} updatePositionStrategy="always">
                <MenuItem icon={<History />} shortcut="Ctrl+H" onSelect={() => show('history')}>Show all history</MenuItem>
                {snapshot.history.length ? <><Menu.Separator className="bp-separator" /><Menu.Label className="bp-menu-label">Recently visited</Menu.Label>{snapshot.history.slice(0, 6).map((entry) => <MenuItem key={entry.id} icon={<Globe />} onSelect={() => navigate(entry.url)}>{entry.title}</MenuItem>)}</> : <Menu.Label className="bp-menu-label">Your history will appear here</Menu.Label>}
              </Menu.SubContent></Menu.Portal>
            </Menu.Sub>
            <MenuItem icon={<ArrowDownToLine />} shortcut="Ctrl+J" onSelect={() => show('downloads')}>Downloads</MenuItem>
            <Menu.Sub>
              <Menu.SubTrigger className="bp-menu-item" onPointerLeave={preserveSubmenuPointerTransfer}><BookmarkIcon /><span>Bookmarks</span><ChevronRight className="bp-chevron" /></Menu.SubTrigger>
              <Menu.Portal><Menu.SubContent className="bp-submenu" sideOffset={8} collisionPadding={10} updatePositionStrategy="always">
                <MenuItem icon={<BookmarkIcon />} shortcut="Ctrl+D" disabled={!state.url || state.url === 'about:blank'} onSelect={() => { void run(() => ui.command('bookmark-page')) }}>{currentIsBookmarked ? 'Remove this bookmark' : 'Bookmark this tab'}</MenuItem>
                <Menu.CheckboxItem className="bp-menu-item" checked={snapshot.settings.showBookmarksBar} onCheckedChange={(checked) => { void run(() => ui.updateSettings({ showBookmarksBar: checked })) }} onSelect={(event) => event.preventDefault()}><span className="bp-check-slot">{snapshot.settings.showBookmarksBar ? <Check /> : null}</span><span>Show bookmarks bar</span><kbd>Ctrl+Shift+B</kbd></Menu.CheckboxItem>
                <MenuItem icon={<MoreHorizontal />} shortcut="Ctrl+Shift+O" onSelect={() => show('bookmarks')}>Bookmark manager</MenuItem>
                {snapshot.bookmarks.length ? <><Menu.Separator className="bp-separator" />{snapshot.bookmarks.slice(0, 6).map((entry) => <MenuItem key={entry.id} icon={<Globe />} onSelect={() => navigate(entry.url)}>{entry.title}</MenuItem>)}</> : null}
              </Menu.SubContent></Menu.Portal>
            </Menu.Sub>
          </Menu.Group>
          <Menu.Separator className="bp-separator" />
          <MenuItem icon={<Trash2 />} shortcut="Ctrl+Shift+Del" onSelect={() => show('clear-data')}>Delete browsing data…</MenuItem>
          <Menu.Item asChild onSelect={(event) => event.preventDefault()}><div className="bp-menu-zoom" aria-label={`Page zoom, ${state.zoom} percent. Use left and right arrows to change zoom.`} onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return
            if (['ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) { event.preventDefault(); void run(() => ui.zoom(state.targetId, event.key === 'ArrowLeft' ? 'out' : event.key === 'ArrowRight' ? 'in' : 'reset')) }
          }}><Search /><span>Zoom</span><div>
            <IconButton label="Zoom out" disabled={state.zoom <= 25} onClick={() => { void run(() => ui.zoom(state.targetId, 'out')) }}><Minus /></IconButton>
            <button className="bp-zoom-value" type="button" aria-label="Reset zoom" title="Reset zoom (Ctrl+0)" onClick={() => { void run(() => ui.zoom(state.targetId, 'reset')) }}>{state.zoom}%</button>
            <IconButton label="Zoom in" disabled={state.zoom >= 500} onClick={() => { void run(() => ui.zoom(state.targetId, 'in')) }}><Plus /></IconButton>
            <span className="bp-zoom-divider" />
            <IconButton label="Toggle full screen" onClick={() => closeAction(() => ui.fullscreen())}><Maximize /></IconButton>
          </div></div></Menu.Item>
          <MenuItem icon={<Printer />} shortcut="Ctrl+P" disabled={!state.targetId || state.url === 'about:blank'} onSelect={() => closeAction(() => ui.print(state.targetId))}>Print…</MenuItem>
          <Menu.Separator className="bp-separator" />
          <MenuItem icon={<Info />} onSelect={() => show('about')}>About Orbit</MenuItem>
          <MenuItem icon={<Settings />} onSelect={() => show('settings')}>Settings</MenuItem>
          <MenuItem icon={<LogOut />} onSelect={() => closeAction(() => ui.exit())}>Exit</MenuItem>
        </motion.div>
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>
}

function dayLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return 'Today'
  today.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

function HistoryPanel({ snapshot, actions }: { snapshot: BrowserSnapshot; actions: Actions }) {
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [limit, setLimit] = useState(150)
  const filtered = snapshot.history.filter((entry) => `${entry.title} ${entry.url}`.toLowerCase().includes(query.toLowerCase()))
  const selectedIds = snapshot.history.filter((entry) => selection.has(entry.id)).map((entry) => entry.id)
  const groups = new Map<string, typeof filtered>()
  for (const entry of filtered.slice(0, limit)) { const label = dayLabel(entry.visitedAt); groups.set(label, [...(groups.get(label) ?? []), entry]) }
  return <>
    <SearchField value={query} onChange={(value) => { setQuery(value); setLimit(150) }} placeholder="Search history" />
    <div className="bp-list-toolbar"><span>{filtered.length.toLocaleString()} {filtered.length === 1 ? 'visit' : 'visits'}</span>{selectedIds.length ? <button type="button" className="bp-button bp-button-danger" onClick={() => { void actions.run(() => actions.ui.deleteHistory(selectedIds)).then((ok) => { if (ok) setSelection(new Set()) }) }}><Trash2 size={14} />Delete selected ({selectedIds.length})</button> : <button type="button" className="bp-button bp-button-ghost" onClick={() => actions.show('clear-data')}>Delete browsing data</button>}</div>
    {!filtered.length ? <EmptyState icon={<History />} title={query ? 'No matching visits' : 'Your history starts here'} description={query ? 'Try another page title or website address.' : 'Pages you visit in Orbit will appear here.'} /> : [...groups.entries()].map(([label, entries]) => <section key={label} className="bp-history-group"><h3>{label}</h3>{entries.map((entry) => <div className="bp-history-row" key={entry.id}>
      <input type="checkbox" aria-label={`Select ${entry.title}`} checked={selection.has(entry.id)} onChange={(event) => setSelection((current) => { const next = new Set(current); if (event.target.checked) next.add(entry.id); else next.delete(entry.id); return next })} />
      <span className="bp-time">{new Date(entry.visitedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span><Globe size={17} className="bp-muted" aria-hidden="true" />
      <button type="button" className="bp-page-link" onClick={() => actions.navigate(entry.url)} title={entry.url}><strong>{entry.title}</strong><span>{entry.url}</span></button>
      <IconButton label={`Delete visit: ${entry.title}`} onClick={() => { void actions.run(() => actions.ui.deleteHistory([entry.id])) }}><X size={15} /></IconButton>
    </div>)}</section>)}
    {filtered.length > limit ? <button className="bp-button bp-load-more" type="button" onClick={() => setLimit((value) => value + 150)}>Show more history</button> : null}
  </>
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function DownloadPreferences({ snapshot, actions }: { snapshot: BrowserSnapshot; actions: Actions }) {
  return <div className="bp-card bp-download-preferences"><div className="bp-folder-label"><FolderOpen size={18} /><span>Download location</span><button className="bp-button" type="button" onClick={() => { void actions.run(() => actions.ui.chooseDownloadFolder(), 'Download location updated') }}>Change</button></div><p className="bp-folder-path" title={snapshot.settings.downloadFolder}>{snapshot.settings.downloadFolder}</p><Toggle label="Ask where to save each file" checked={snapshot.settings.askWhereToSave} onChange={(checked) => { void actions.run(() => actions.ui.updateSettings({ askWhereToSave: checked })) }} /></div>
}

function DownloadCard({ entry, actions }: { entry: DownloadEntry; actions: Actions }) {
  const active = entry.state === 'progressing'
  const resumable = entry.canResume || (active && entry.paused)
  const percentage = entry.totalBytes > 0 ? Math.min(100, Math.round(entry.receivedBytes / entry.totalBytes * 100)) : null
  const remaining = entry.bytesPerSecond > 0 && entry.totalBytes > entry.receivedBytes ? Math.ceil((entry.totalBytes - entry.receivedBytes) / entry.bytesPerSecond) : null
  const status = entry.paused ? 'Paused' : entry.state === 'completed' ? 'Completed' : entry.state === 'cancelled' ? 'Cancelled' : entry.state === 'interrupted' ? 'Interrupted' : 'Downloading'
  const action = (value: Parameters<BrowserUIBridge['downloadAction']>[1]) => { void actions.run(() => actions.ui.downloadAction(entry.id, value)) }
  return <motion.article layout="position" className="bp-card bp-download-card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 12 }}>
    <div className={`bp-file-icon ${entry.state === 'completed' ? 'bp-file-icon-complete' : ''}`}>{entry.state === 'completed' ? <Check size={22} /> : <File size={22} />}</div><div className="bp-download-content">
      <div className="bp-download-title"><h3 title={entry.filename}>{entry.filename}</h3><span className={`bp-status bp-status-${entry.state}`}>{status}</span></div>
      <p className="bp-download-source" title={entry.url}>{entry.url}</p>
      {active || resumable ? <div className={`bp-progress ${percentage === null ? 'bp-progress-indeterminate' : ''}`} role="progressbar" aria-label={`Download progress: ${entry.filename}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage ?? undefined}><motion.div animate={{ scaleX: percentage === null ? 0.35 : percentage / 100 }} transition={{ duration: 0.2 }} /></div> : null}
      <p className="bp-download-detail">{formatBytes(entry.receivedBytes)}{entry.totalBytes > 0 ? ` of ${formatBytes(entry.totalBytes)}` : ''}{active && !entry.paused && entry.bytesPerSecond > 0 ? ` · ${formatBytes(entry.bytesPerSecond)}/s` : ''}{remaining !== null && active && !entry.paused ? ` · ${remaining >= 60 ? `${Math.ceil(remaining / 60)} min` : `${remaining} sec`} left` : ''}{percentage !== null && active ? ` · ${percentage}%` : ''}</p>
      <div className="bp-download-actions">
        {active && !entry.paused ? <button type="button" className="bp-button" onClick={() => action('pause')}><Pause size={13} />Pause</button> : null}
        {resumable ? <button type="button" className="bp-button" onClick={() => action('resume')}><Play size={13} />Resume</button> : null}
        {active || resumable ? <button type="button" className="bp-button bp-button-ghost" onClick={() => action('cancel')}><X size={13} />Cancel</button> : null}
        {entry.state === 'completed' ? <><button type="button" className="bp-button" onClick={() => action('open')}><ExternalLink size={13} />Open file</button><button type="button" className="bp-button bp-button-ghost" onClick={() => action('show')}><FolderOpen size={13} />Show in folder</button></> : null}
        {!active && !resumable && entry.state !== 'completed' && /^(https?|file):/.test(entry.url) ? <button type="button" className="bp-button" onClick={() => action('retry')}><RotateCcw size={13} />Retry</button> : null}
        {!active && !resumable ? <IconButton label={`Remove download: ${entry.filename}`} onClick={() => action('remove')}><Trash2 size={14} /></IconButton> : null}
      </div>
    </div>
  </motion.article>
}

function DownloadsPanel({ snapshot, actions }: { snapshot: BrowserSnapshot; actions: Actions }) {
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(50)
  const entries = snapshot.downloads.filter((entry) => `${entry.filename} ${entry.url}`.toLowerCase().includes(query.toLowerCase()))
  return <><DownloadPreferences snapshot={snapshot} actions={actions} /><SearchField value={query} onChange={(value) => { setQuery(value); setLimit(50) }} placeholder="Search downloads" /><div className="bp-list-toolbar"><span>{snapshot.downloads.filter((entry) => entry.state === 'progressing').length} active · {entries.length} files</span><button className="bp-button bp-button-ghost" type="button" onClick={() => { void actions.run(() => actions.ui.openDownloadFolder()) }}><FolderOpen size={14} />Open folder</button></div>
    {entries.length ? <div className="bp-download-list"><AnimatePresence initial={false}>{entries.slice(0, limit).map((entry) => <DownloadCard key={entry.id} entry={entry} actions={actions} />)}</AnimatePresence></div> : <EmptyState icon={<Download />} title={query ? 'No matching downloads' : 'Your downloads, all in one place'} description={query ? 'Try another filename or website address.' : 'Download a file from any page to see its progress here.'} />}
    {entries.length > limit ? <button className="bp-button bp-load-more" type="button" onClick={() => setLimit((value) => value + 50)}>Show more downloads</button> : null}
  </>
}

function BookmarksPanel({ snapshot, actions, state }: { snapshot: BrowserSnapshot; actions: Actions; state: OverlayState }) {
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(100)
  const [editing, setEditing] = useState<Partial<Bookmark> | null>(null)
  const [saving, setSaving] = useState(false)
  const entries = snapshot.bookmarks.filter((entry) => `${entry.title} ${entry.url}`.toLowerCase().includes(query.toLowerCase()))
  const save = async () => {
    if (!editing?.url || !editing.title) return
    setSaving(true)
    const ok = await actions.run(() => actions.ui.saveBookmark({ id: editing.id, title: editing.title!, url: editing.url! }), 'Bookmark saved')
    setSaving(false)
    if (ok) setEditing(null)
  }
  return <><SearchField value={query} onChange={(value) => { setQuery(value); setLimit(100) }} placeholder="Search bookmarks" /><div className="bp-list-toolbar"><span>{entries.length} {entries.length === 1 ? 'bookmark' : 'bookmarks'}</span><button className="bp-button" type="button" onClick={() => setEditing({ title: state.url === 'about:blank' ? '' : state.title, url: state.url === 'about:blank' ? '' : state.url })}><Plus size={14} />Add bookmark</button></div>
    {editing ? <form className="bp-card bp-bookmark-form" onSubmit={(event) => { event.preventDefault(); void save() }}><h3>{editing.id ? 'Edit bookmark' : 'Add bookmark'}</h3><label htmlFor="bookmark-name">Name</label><input id="bookmark-name" autoFocus required maxLength={500} value={editing.title ?? ''} onChange={(event) => setEditing({ ...editing, title: event.target.value })} /><label htmlFor="bookmark-url">URL</label><input id="bookmark-url" type="url" required value={editing.url ?? ''} onChange={(event) => setEditing({ ...editing, url: event.target.value })} placeholder="https://example.com" /><div className="bp-form-actions"><button className="bp-button" type="button" onClick={() => setEditing(null)}>Cancel</button><button className="bp-button bp-button-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save bookmark'}</button></div></form> : null}
    {entries.length ? <div className="bp-bookmark-list">{entries.slice(0, limit).map((entry) => <motion.div layout="position" className="bp-bookmark-row" key={entry.id}><span className="bp-site-icon"><BookmarkIcon size={17} /></span><button type="button" className="bp-page-link" onClick={() => actions.navigate(entry.url)} title={entry.url}><strong>{entry.title}</strong><span>{entry.url}</span></button><IconButton label={`Edit bookmark: ${entry.title}`} onClick={() => setEditing(entry)}><Pencil size={15} /></IconButton><IconButton label={`Delete bookmark: ${entry.title}`} onClick={() => { void actions.run(() => actions.ui.deleteBookmark(entry.id)) }}><Trash2 size={15} /></IconButton></motion.div>)}</div> : <EmptyState icon={<BookmarkIcon />} title={query ? 'No matching bookmarks' : 'Keep your favorite pages close'} description={query ? 'Try a different name or address.' : 'Use the star in the address bar, or add a bookmark here.'} />}
    {entries.length > limit ? <button className="bp-button bp-load-more" type="button" onClick={() => setLimit((value) => value + 100)}>Show more bookmarks</button> : null}
  </>
}

function ClearDataPanel({ actions }: { actions: Actions }) {
  const [request, setRequest] = useState<ClearDataRequest>({ range: 'hour', history: true, downloads: false, cookies: false, cache: true })
  const [busy, setBusy] = useState(false)
  const [completed, setCompleted] = useState(false)
  const choices = [
    { key: 'history' as const, label: 'Browsing history', detail: 'Remove visited pages for the selected time range.' },
    { key: 'downloads' as const, label: 'Download history', detail: 'Remove finished download records. Your files stay on disk.' },
    { key: 'cookies' as const, label: 'Cookies and other site data', detail: 'Clear data from all websites. You may be signed out.' },
    { key: 'cache' as const, label: 'Cached images and files', detail: 'Clear the browser cache for all websites.' },
  ]
  return <><div className="bp-clear-intro"><Shield size={20} /><p>Choose what to clear from your browser.</p></div><label className="bp-label" htmlFor="clear-time-range">Time range</label><select id="clear-time-range" value={request.range} disabled={busy} onChange={(event) => { setCompleted(false); setRequest({ ...request, range: event.target.value as ClearDataRequest['range'] }) }}><option value="hour">Last hour</option><option value="day">Last 24 hours</option><option value="week">Last 7 days</option><option value="month">Last 4 weeks</option><option value="all">All time</option></select><div className="bp-clear-options">{choices.map(({ key, label, detail }) => <label className="bp-clear-option" key={key}><input type="checkbox" checked={request[key]} disabled={busy} onChange={(event) => { setCompleted(false); setRequest({ ...request, [key]: event.target.checked }) }} /><span><strong>{label}</strong><small>{detail}</small></span></label>)}</div>
    {request.cookies || request.cache ? <p className="bp-note"><Info size={15} />The time range applies to browsing and download history. Cookies, site data, and cache are cleared for all time.</p> : null}
    <div className="bp-form-actions"><button className="bp-button" type="button" disabled={busy} onClick={() => actions.show('settings')}>Cancel</button><button className="bp-button bp-button-primary" type="button" disabled={busy || !(request.history || request.downloads || request.cookies || request.cache)} onClick={() => { setBusy(true); void actions.run(() => actions.ui.clearData(request)).then((ok) => { setBusy(false); setCompleted(ok) }) }}>{busy ? 'Clearing…' : 'Delete data'}</button></div>{completed ? <p className="bp-success" role="status"><Check size={16} />Selected browsing data deleted.</p> : null}
  </>
}

function SettingsPanel({ snapshot, actions, closeAction }: { snapshot: BrowserSnapshot; actions: Actions; closeAction: (action?: () => Promise<unknown>) => void }) {
  return <><div className="bp-settings-heading"><PanelTop size={18} /><h3>Appearance & browsing</h3></div><div className="bp-card bp-settings-card"><Toggle label="Show bookmarks bar" description="Keep saved pages just below the address bar." checked={snapshot.settings.showBookmarksBar} onChange={(checked) => { void actions.run(() => actions.ui.updateSettings({ showBookmarksBar: checked })) }} /><div className="bp-setting-row"><div><label className="bp-setting-title" htmlFor="default-zoom">Default page zoom</label><p>Applied when a new browser tab is created.</p></div><select id="default-zoom" value={snapshot.settings.defaultZoom} onChange={(event) => { void actions.run(() => actions.ui.updateSettings({ defaultZoom: Number(event.target.value) })) }}>{ZOOM_LEVELS.map((value) => <option key={value} value={value}>{value}%</option>)}</select></div></div>
    <div className="bp-settings-heading"><Download size={18} /><h3>Downloads</h3></div><DownloadPreferences snapshot={snapshot} actions={actions} />
    <div className="bp-settings-heading"><Shield size={18} /><h3>Privacy</h3></div><div className="bp-card bp-settings-card"><Toggle label="Allow Microphone Access for AI Features" description="Send voice input to Gemini while recording. Turning this off stops recording and clears approval; the next mic click asks again." checked={snapshot.settings.allowAiMicrophone} onChange={(checked) => { void actions.run(() => actions.ui.updateSettings({ allowAiMicrophone: checked })) }} /><button className="bp-settings-link" type="button" onClick={() => actions.show('clear-data')}><div><strong>Delete browsing data</strong><p>Manage history, cookies, and cached files.</p></div><ChevronRight size={17} /></button></div>
    <div className="bp-settings-heading"><Settings size={18} /><h3>AI Agent</h3></div><div className="bp-card bp-settings-card"><button className="bp-settings-link" type="button" onClick={() => closeAction(() => actions.ui.command('provider-settings'))}><div><strong>AI providers & models</strong><p>Configure the providers used by your assistant.</p></div><ArrowUpRight size={17} /></button></div><button className="bp-button bp-button-ghost bp-about-link" type="button" onClick={() => actions.show('about')}>About Orbit <ChevronRight size={14} /></button></>
}

function updateButton(update: UpdateState | null): { label: string; icon: ReactNode; primary: boolean; disabled: boolean } {
  switch (update?.status) {
    case 'checking': return { label: 'Checking…', icon: <LoaderCircle size={13} className="bp-spin" />, primary: false, disabled: true }
    case 'available': return { label: 'Update', icon: <CircleArrowUp size={13} />, primary: true, disabled: false }
    case 'downloading': return { label: `${Math.floor(update.progress?.percent ?? 0)}%`, icon: <LoaderCircle size={13} className="bp-spin" />, primary: false, disabled: true }
    case 'downloaded': return { label: 'Restart to update', icon: <RotateCw size={13} />, primary: true, disabled: false }
    case 'installing': return { label: 'Restarting…', icon: <LoaderCircle size={13} className="bp-spin" />, primary: true, disabled: true }
    case 'error': return { label: 'Try again', icon: <RefreshCw size={13} />, primary: false, disabled: false }
    default: return { label: 'Check for updates', icon: <RefreshCw size={13} />, primary: false, disabled: !update || update.status === 'unsupported' }
  }
}

function RuntimeChange({ label, current, next }: { label: string; current: string; next?: string }) {
  if (!next) return null
  return <div><dt>{label}</dt><dd>{next === current ? <><code>{current}</code><span className="bp-muted">unchanged</span></> : <><code className="bp-muted">{current}</code><span aria-hidden="true">→</span><code className="bp-update-new">{next}</code></>}</dd></div>
}

function AboutPanel({ snapshot, update, actions }: { snapshot: BrowserSnapshot; update: UpdateState | null; actions: Actions }) {
  const [confirmRestart, setConfirmRestart] = useState(false)
  const details = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  const status = update?.status
  // The update card and the restart prompt sit below the version table, out of view in a short
  // window: bring them in whenever they change, or pressing the button would seem to do nothing.
  useEffect(() => {
    if (status && status !== 'idle' && status !== 'unsupported' && status !== 'checking') details.current?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' })
  }, [status, confirmRestart, reduceMotion])
  const { versions } = snapshot
  const release = update?.release ?? null
  const button = updateButton(update)
  const progress = update?.status === 'downloading' ? update.progress : null
  const ready = update?.status === 'downloaded' || update?.status === 'installing'
  const onUpdate = () => {
    if (update?.status === 'downloaded') setConfirmRestart(true)
    else if (release && (update?.status === 'available' || update?.status === 'error')) void actions.run(() => actions.ui.downloadUpdate())
    else void actions.run(() => actions.ui.checkForUpdates())
  }
  return <><div className="bp-about-hero"><BrowserLogo size={70} /><h3>Orbit</h3><p>A browser for agentic search<br />with prompt defense.</p><span className="bp-version">Version {versions.orbit}</span></div>
    {update?.updatedFrom ? <p className="bp-success" role="status"><CircleCheck size={16} />Updated from Orbit {update.updatedFrom.orbit}{update.updatedFrom.chromium !== versions.chromium ? ` · Chromium ${update.updatedFrom.chromium} → ${versions.chromium}` : ''}</p> : null}
    <div className="bp-card bp-version-table">
      <div><span>Chromium</span><div className="bp-version-value"><code>{versions.chromium}</code><button type="button" className={`bp-button bp-update-button ${button.primary ? 'bp-button-primary' : ''}`} disabled={button.disabled} onClick={onUpdate} aria-describedby="bp-update-status">{button.icon}{button.label}</button></div></div>
      {[['Electron', versions.electron], ['Node.js', versions.node], ['Platform', versions.platform]].map(([label, value]) => <div key={label}><span>{label}</span><code>{value}</code></div>)}
    </div>
    <div id="bp-update-status" ref={details} aria-live="polite">
      {release && update && update.status !== 'up-to-date' ? <section className="bp-card bp-update-card" aria-label="Available update">
        <h4><CircleArrowUp size={16} />Orbit {release.version} {ready ? 'is ready to install' : 'is available'}</h4>
        {release.runtime.chromium || release.runtime.electron ? <dl className="bp-update-runtime"><RuntimeChange label="Chromium" current={versions.chromium} next={release.runtime.chromium} /><RuntimeChange label="Electron" current={versions.electron} next={release.runtime.electron} /></dl> : null}
        {progress ? <><div className="bp-progress" role="progressbar" aria-label="Update download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(progress.percent)}><motion.div animate={{ scaleX: progress.percent / 100 }} transition={{ duration: 0.2 }} /></div><p className="bp-update-detail">{formatBytes(progress.transferred)}{progress.total ? ` of ${formatBytes(progress.total)}` : ''}{progress.bytesPerSecond ? ` · ${formatBytes(progress.bytesPerSecond)}/s` : ''}</p></> : null}
        {update.status === 'downloaded' && confirmRestart ? <div className="bp-update-confirm"><p>Orbit will close, install the update, and open again. Open tabs won't be restored.</p><div className="bp-form-actions"><button className="bp-button" type="button" onClick={() => setConfirmRestart(false)}>Not now</button><button className="bp-button bp-button-primary" type="button" onClick={() => { void actions.run(() => actions.ui.installUpdate()) }}><RotateCw size={13} />Restart now</button></div></div>
          : <p className="bp-update-detail">{update.status === 'downloaded' ? 'Restart Orbit to finish updating, or it will update the next time it closes.' : update.status === 'installing' ? 'Closing Orbit to install the update…' : 'Your bookmarks, history, and settings are kept.'}</p>}
      </section> : null}
      {update?.status === 'error' ? <div className="bp-alert" role="alert"><Info size={16} /><span>{update.error}</span></div> : null}
      {update?.status === 'unsupported' ? <p className="bp-update-status">{update.reason}</p> : update?.status === 'up-to-date' ? <p className="bp-update-status"><CircleCheck size={14} />Orbit is up to date.</p> : null}
    </div>
    {/* "Built with Llama" is a condition of the Llama 4 Community License the detection model ships under. */}
    <p className="bp-note bp-about-note">Built on Chromium. Designed for thoughtful browsing.<br />Prompt-injection model: Llama Prompt Guard 2 · Built with Llama</p></>
}

const PANEL_DETAILS: Partial<Record<BrowserPanel, { title: string; description: string; icon: ReactNode }>> = {
  history: { title: 'History', description: 'Find your way back to pages you visited.', icon: <History /> },
  downloads: { title: 'Downloads', description: 'Track your files from start to finish.', icon: <Download /> },
  bookmarks: { title: 'Bookmarks', description: 'Your favorite pages, organized in one place.', icon: <BookmarkIcon /> },
  'clear-data': { title: 'Delete browsing data', description: 'Control the data stored by your browser.', icon: <Trash2 /> },
  settings: { title: 'Settings', description: 'Make Orbit feel like your browser.', icon: <Settings /> },
  about: { title: 'About Orbit', description: 'Browser and runtime information.', icon: <Info /> },
}

export function BrowserOverlay() {
  const ui = window.electronAPI?.browserUI
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null)
  const [state, setState] = useState<OverlayState | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const currentState = useRef<OverlayState | null>(null)
  const exitAction = useRef<(() => Promise<unknown>) | undefined>(undefined)
  const reduceMotion = useReducedMotion()
  const run = useCallback(async (action: () => Promise<unknown>, success?: string) => {
    setError('')
    try { await action(); if (success) setNotice(success); return true } catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'The browser action could not be completed.'); return false }
  }, [])
  const receiveState = useCallback((value: OverlayState | null) => { exitAction.current = undefined; currentState.current = value; setState(value); setError(''); setNotice('') }, [])
  const closeAction = useCallback((action?: () => Promise<unknown>) => { exitAction.current = action; currentState.current = null; setState(null) }, [])

  useEffect(() => {
    if (!ui) return
    const stopSnapshot = ui.onSnapshot(setSnapshot)
    const stopOverlay = ui.onOverlay(receiveState)
    const stopDownloads = ui.onDownload((entry) => setSnapshot((current) => current ? { ...current, downloads: current.downloads.map((download) => download.id === entry.id ? entry : download) } : current))
    const stopUpdate = ui.onUpdate(setUpdate)
    void ui.snapshot().then((value) => { setSnapshot(value); ui.ready() }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Browser data could not be loaded.'))
    // A pushed state is newer than the reply to this request when it lands first.
    void ui.updateState().then((value) => setUpdate((current) => current ?? value)).catch(() => undefined)
    return () => { stopSnapshot(); stopOverlay(); stopDownloads(); stopUpdate() }
  }, [receiveState, ui])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(''), 3000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  if (!ui || !snapshot) return null
  const actions: Actions = { ui, run, navigate: (url) => closeAction(() => ui.command('new-tab', url)), show: (panel) => { if (state) void run(() => ui.show(panel, state.targetId, state.anchor)) } }
  const sheet = state && ['history', 'downloads', 'bookmarks'].includes(state.panel)
  const details = state && state.panel !== 'menu' ? PANEL_DETAILS[state.panel] : null
  return <MotionConfig reducedMotion="user"><div className="browser-overlay-root"><AnimatePresence mode="wait" onExitComplete={() => {
    if (currentState.current !== null) return
    const after = exitAction.current
    exitAction.current = undefined
    void run(async () => { await ui.close(); if (after) await after() })
  }}>
    {state ? <motion.div key={state.panel} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.12 }}>
      {state.panel === 'permission' || state.panel === 'connection' ? <SiteControlsPopup state={state} close={() => { void run(() => ui.close()) }} decide={(id, allow) => { void run(() => ui.decidePermission(id, allow)) }} /> : state.panel === 'menu' ? <BrowserMenu state={state} snapshot={snapshot} update={update} actions={actions} closeAction={closeAction} /> : details ? <Dialog.Root open onOpenChange={(open) => { if (!open) closeAction() }}><Dialog.Portal forceMount>
        <Dialog.Overlay asChild><motion.div className="bp-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.18 }} /></Dialog.Overlay>
        <Dialog.Content asChild forceMount onCloseAutoFocus={(event) => event.preventDefault()}><motion.section className={`bp-panel ${sheet ? 'bp-sheet' : 'bp-dialog'} bp-panel-${state.panel}`} initial={reduceMotion ? { opacity: 0 } : sheet ? { x: 42, opacity: 0 } : { y: 12, scale: 0.97, opacity: 0 }} animate={{ x: 0, y: 0, scale: 1, opacity: 1 }} exit={reduceMotion ? { opacity: 0 } : sheet ? { x: 28, opacity: 0 } : { y: 6, scale: 0.98, opacity: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 34 }}>
          <header className="bp-panel-header"><span className="bp-panel-symbol">{details.icon}</span><div><Dialog.Title>{details.title}</Dialog.Title><Dialog.Description>{details.description}</Dialog.Description></div><IconButton label={`Close ${details.title}`} onClick={() => closeAction()}><X size={18} /></IconButton></header>
          <div className="bp-panel-body">
            {error ? <div className="bp-alert" role="alert"><Info size={16} /><span>{error}</span><IconButton label="Dismiss error" onClick={() => setError('')}><X size={14} /></IconButton></div> : null}
            {notice ? <div className="bp-success" role="status"><Check size={16} />{notice}</div> : null}
            {state.panel === 'history' ? <HistoryPanel snapshot={snapshot} actions={actions} /> : state.panel === 'downloads' ? <DownloadsPanel snapshot={snapshot} actions={actions} /> : state.panel === 'bookmarks' ? <BookmarksPanel snapshot={snapshot} actions={actions} state={state} /> : state.panel === 'clear-data' ? <ClearDataPanel actions={actions} /> : state.panel === 'settings' ? <SettingsPanel snapshot={snapshot} actions={actions} closeAction={closeAction} /> : <AboutPanel snapshot={snapshot} update={update} actions={actions} />}
          </div><footer className="bp-panel-footer"><BrowserLogo size={16} /><span>Orbit</span><span>{state.panel === 'downloads' ? 'Files stay on your device' : state.panel === 'history' ? 'History is saved on this device' : 'Your space to browse'}</span></footer>
        </motion.section></Dialog.Content>
      </Dialog.Portal></Dialog.Root> : null}
      {state.panel === 'menu' && error ? <div className="bp-menu-error" role="alert">{error}</div> : null}
    </motion.div> : null}
  </AnimatePresence></div></MotionConfig>
}
