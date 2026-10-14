import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ZOOM_LEVELS, type Bookmark, type BrowserSettings, type BrowserSnapshot, type DownloadEntry, type HistoryEntry } from './browserUITypes.js'

export function isBrowserUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 16_384) return false
  try { return ['http:', 'https:', 'file:'].includes(new URL(value).protocol) } catch { return false }
}

/** The profile is shared across Orbit windows, separate from credentials and guest site storage. */
export class BrowserProfileStore {
  private readonly file = path.join(app.getPath('userData'), 'browser-profile.json')
  private timer: ReturnType<typeof setTimeout> | undefined
  private bookmarkMigrationComplete = false
  private readonly orbitVersion = app.isPackaged ? app.getVersion() : this.readPackageVersion()
  history: HistoryEntry[] = []
  downloads: DownloadEntry[] = []
  bookmarks: Bookmark[] = []
  settings: BrowserSettings = { downloadFolder: app.getPath('downloads'), askWhereToSave: false, showBookmarksBar: true, defaultZoom: 100 }
  onChange = () => {}

  constructor() {
    try {
      if (!existsSync(this.file)) return
      const data = JSON.parse(readFileSync(this.file, 'utf8'))
      this.history = (Array.isArray(data.history) ? data.history : []).filter((entry: HistoryEntry) =>
        typeof entry.id === 'string' && typeof entry.title === 'string' && isBrowserUrl(entry.url) && Number.isFinite(entry.visitedAt)).slice(0, 10_000)
      this.bookmarks = (Array.isArray(data.bookmarks) ? data.bookmarks : []).filter((entry: Bookmark) =>
        typeof entry.id === 'string' && typeof entry.title === 'string' && isBrowserUrl(entry.url) && Number.isFinite(entry.createdAt)).slice(0, 5_000)
      this.downloads = (Array.isArray(data.downloads) ? data.downloads : []).filter((entry: DownloadEntry) =>
        typeof entry.id === 'string' && typeof entry.filename === 'string' && typeof entry.savePath === 'string' && typeof entry.url === 'string' &&
        Number.isFinite(entry.startedAt) && Number.isFinite(entry.totalBytes) && Number.isFinite(entry.receivedBytes)).slice(0, 500)
        .map((entry: DownloadEntry) => ({ ...entry, state: entry.state === 'progressing' ? 'interrupted' : entry.state, paused: false, canResume: false, bytesPerSecond: 0 }))
      this.bookmarkMigrationComplete = data.bookmarkMigrationComplete === true
      if (typeof data.settings?.downloadFolder === 'string' && path.isAbsolute(data.settings.downloadFolder)) this.settings.downloadFolder = data.settings.downloadFolder
      this.updateSettings(data.settings, false)
    } catch (error) { console.warn('[browser-profile] Could not read saved profile:', error) }
  }

  snapshot(): BrowserSnapshot {
    return { history: this.history, downloads: this.downloads, bookmarks: this.bookmarks, settings: this.settings,
      versions: { orbit: this.orbitVersion, electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, platform: `${process.platform} (${process.arch})` } }
  }

  private readPackageVersion(): string {
    try { return JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')).version as string } catch { return app.getVersion() }
  }

  changed(notify = true): void {
    if (notify) this.onChange()
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 350)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ ...this.snapshot(), bookmarkMigrationComplete: this.bookmarkMigrationComplete }), 'utf8')
      renameSync(`${this.file}.tmp`, this.file)
    } catch (error) { console.error('[browser-profile] Could not save profile:', error) }
  }

  updateSettings(value: Partial<BrowserSettings> | undefined, notify = true): void {
    if (!value || typeof value !== 'object') return
    if (typeof value.askWhereToSave === 'boolean') this.settings.askWhereToSave = value.askWhereToSave
    if (typeof value.showBookmarksBar === 'boolean') this.settings.showBookmarksBar = value.showBookmarksBar
    if (typeof value.defaultZoom === 'number' && ZOOM_LEVELS.includes(value.defaultZoom)) this.settings.defaultZoom = value.defaultZoom
    if (notify) this.changed()
  }

  recordVisit(url: string, title: string): string | null {
    if (!isBrowserUrl(url)) return null
    const entry = { id: randomUUID(), url, title: title || new URL(url).hostname || url, visitedAt: Date.now() }
    this.history.unshift(entry)
    this.history = this.history.slice(0, 10_000)
    this.changed()
    return entry.id
  }

  updateVisit(id: string | null, title: string): void {
    const entry = this.history.find((item) => item.id === id)
    if (entry && title && entry.title !== title) { entry.title = title; this.changed() }
  }

  saveBookmark(value: Pick<Bookmark, 'title' | 'url'> & { id?: string }): void {
    if (!value || !isBrowserUrl(value.url) || typeof value.title !== 'string') throw new Error('Enter a valid page URL and title.')
    const existing = value.id ? this.bookmarks.find((entry) => entry.id === value.id) : this.bookmarks.find((entry) => entry.url === value.url)
    if (existing) Object.assign(existing, { title: value.title.trim().slice(0, 500) || value.url, url: value.url, favicon: undefined })
    else this.bookmarks.push({ id: randomUUID(), title: value.title.trim().slice(0, 500) || value.url, url: value.url, createdAt: Date.now() })
    this.changed()
  }

  importBookmarks(values: Bookmark[]): void {
    if (this.bookmarkMigrationComplete || !Array.isArray(values)) return
    for (const entry of values.slice(0, 5_000)) {
      if (entry && isBrowserUrl(entry.url) && typeof entry.title === 'string' && !this.bookmarks.some((item) => item.url === entry.url)) {
        this.bookmarks.push({ id: randomUUID(), title: entry.title.slice(0, 500), url: entry.url, createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now() })
      }
    }
    this.bookmarkMigrationComplete = true
    this.changed()
  }
}
