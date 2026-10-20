export type BrowserPanel = 'menu' | 'history' | 'downloads' | 'bookmarks' | 'clear-data' | 'settings' | 'about' | 'permission' | 'connection'
export type SitePermission = 'camera' | 'microphone' | 'geolocation' | 'notifications' | 'clipboard-read' | 'clipboard-write' | 'fullscreen' | 'pointerLock' | 'idle-detection' | 'midi' | 'midiSysex' | 'speaker-selection' | 'keyboardLock' | 'window-management'
export type PermissionPrompt = { id: string; targetId: number; origin: string; permissions: SitePermission[] }
export type ConnectionInfo = { url: string; status: 'internal' | 'http' | 'checking' | 'encrypted' | 'insecure' | 'certificate-error' | 'unavailable'; detail?: string }
export type BrowserCommand = 'new-tab' | 'bookmark-page' | 'toggle-bookmarks' | 'focus-address' | 'close-tab' | 'next-tab' | 'previous-tab' | 'provider-settings'
export type Bookmark = { id: string; title: string; url: string; favicon?: string; createdAt: number }
export type HistoryEntry = { id: string; url: string; title: string; visitedAt: number }
export type DownloadEntry = {
  id: string; filename: string; url: string; savePath: string; startedAt: number
  receivedBytes: number; totalBytes: number; bytesPerSecond: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'; paused: boolean; canResume: boolean
}
export const ZOOM_LEVELS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]
export type BrowserSettings = { downloadFolder: string; askWhereToSave: boolean; showBookmarksBar: boolean; defaultZoom: number; allowAiMicrophone: boolean }
export type RuntimeVersions = { orbit: string; electron: string; chromium: string; node: string }
export type BrowserSnapshot = {
  history: HistoryEntry[]; downloads: DownloadEntry[]; bookmarks: Bookmark[]; settings: BrowserSettings
  versions: RuntimeVersions & { platform: string }
}
export type UpdateStatus = 'unsupported' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'
export type UpdateState = {
  status: UpdateStatus
  /** Why this copy of Orbit cannot update itself, when status is 'unsupported'. */
  reason?: string
  /** The newer release, from the check that finds it until it is installed. `runtime` holds the versions it bundles. */
  release: { version: string; runtime: Partial<RuntimeVersions> } | null
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null
  error: string | null
  checkedAt: number | null
  /** On the first launch after an update: the versions Orbit ran before it. */
  updatedFrom: RuntimeVersions | null
}
export type OverlayState = { panel: BrowserPanel; anchor: { x: number; y: number }; targetId: number | null; url: string; title: string; zoom: number; permission?: PermissionPrompt; connection?: ConnectionInfo }
export type ClearDataRequest = { range: 'hour' | 'day' | 'week' | 'month' | 'all'; history: boolean; downloads: boolean; cookies: boolean; cache: boolean }
export interface BrowserUIBridge {
  snapshot(): Promise<BrowserSnapshot>
  show(panel: BrowserPanel, targetId?: number | null, anchor?: { x: number; y: number }): Promise<void>
  close(): Promise<void>
  ready(): void
  siteAnchor(point: { x: number; y: number }): Promise<void>
  decidePermission(id: string, allow: boolean): Promise<void>
  connection(targetId: number | null): Promise<ConnectionInfo>
  onConnection(listener: (value: { targetId: number; connection: ConnectionInfo }) => void): () => void
  command(command: BrowserCommand, url?: string): Promise<void>
  newWindow(): Promise<void>
  closeWindow(): Promise<void>
  exit(): Promise<void>
  zoom(targetId: number | null, direction: 'in' | 'out' | 'reset'): Promise<number>
  fullscreen(): Promise<void>
  print(targetId: number | null): Promise<void>
  saveBookmark(bookmark: Pick<Bookmark, 'title' | 'url'> & { id?: string }): Promise<void>
  deleteBookmark(id: string): Promise<void>
  importBookmarks(bookmarks: Bookmark[]): Promise<void>
  deleteHistory(ids: string[]): Promise<void>
  clearData(request: ClearDataRequest): Promise<void>
  updateSettings(settings: Partial<Pick<BrowserSettings, 'askWhereToSave' | 'showBookmarksBar' | 'defaultZoom' | 'allowAiMicrophone'>>): Promise<void>
  chooseDownloadFolder(): Promise<void>
  openDownloadFolder(): Promise<void>
  downloadAction(id: string, action: 'pause' | 'resume' | 'cancel' | 'open' | 'show' | 'remove' | 'retry'): Promise<void>
  updateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  onUpdate(listener: (state: UpdateState) => void): () => void
  onSnapshot(listener: (snapshot: BrowserSnapshot) => void): () => void
  onDownload(listener: (download: DownloadEntry) => void): () => void
  onOverlay(listener: (state: OverlayState | null) => void): () => void
  onCommand(listener: (command: { command: BrowserCommand; url?: string }) => void): () => void
  onVisibility(listener: (visible: boolean) => void): () => void
  onRestoreFocus(listener: (target: 'site' | 'menu') => void): () => void
}
