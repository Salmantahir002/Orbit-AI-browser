import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import electronUpdater from 'electron-updater'
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'
import type { RuntimeVersions, UpdateState } from './browserUITypes.js'

const FIRST_CHECK_DELAY_MS = 30_000
const CHECK_INTERVAL_MS = 4 * 60 * 60_000
const VERSION_PATTERN = /^\d+(\.\d+){1,3}([-+][\w.-]{1,40})?$/
const RUNTIME_KEYS = ['orbit', 'electron', 'chromium', 'node'] as const

type UpdaterHooks = {
  /** Runs before the installer starts; the installer must be able to replace every file the app holds open. */
  beforeInstall: () => Promise<void>
  /** Undoes `beforeInstall` when the installer could not be started and Orbit keeps running. */
  installFailed: () => void
}

export function runtimeVersions(orbit: string): RuntimeVersions {
  return { orbit, electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }
}

/** Keeps only well-formed version strings: the values come from a downloaded file and from disk. */
function readVersions(source: unknown): Partial<RuntimeVersions> {
  const record = source && typeof source === 'object' ? source as Record<string, unknown> : {}
  const versions: Partial<RuntimeVersions> = {}
  for (const key of RUNTIME_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && VERSION_PATTERN.test(value)) versions[key] = value
  }
  return versions
}

const NETWORK_ERROR = /net::ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/

/**
 * The feed answered, but holds no Orbit release to update to: nothing is published yet, or the
 * newest release has no latest.yml. For the user that is "up to date", not a failure.
 */
function isNoRelease(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  if (NETWORK_ERROR.test(message)) return false
  if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return true
  // With no release on GitHub, /releases/latest redirects to a page that refuses JSON (406).
  // electron-updater reports "Unable to find latest version on GitHub ... HttpError: 406", wrapped
  // in ERR_UPDATER_INVALID_RELEASE_FEED.
  return /Unable to find latest version on GitHub/.test(message) && /HttpError: 40[46]\b/.test(message)
}

function describeError(error: unknown, action: 'check' | 'download'): string {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'ERR_CHECKSUM_MISMATCH' || /checksum mismatch/i.test(message)) return 'The downloaded update failed its integrity check and was discarded. Try again.'
  if (NETWORK_ERROR.test(message)) return "Orbit couldn't reach the update server. Check your connection and try again."
  return action === 'check' ? "Orbit couldn't check for updates right now. Try again later." : "The update couldn't be downloaded. Try again."
}

/**
 * Updates Orbit the way VS Code and Chrome update themselves. An installed
 * Orbit cannot swap the Chromium inside it, so every release is a whole new
 * build on a newer Electron, published by .github/workflows/release.yml only
 * after the test suite has passed on that Electron. This checks that feed,
 * downloads only when the user asks, and installs when Orbit restarts.
 *
 * Only installed Windows builds update. Dev and e2e runs report 'unsupported',
 * unless ORBIT_UPDATE_CONFIG names an update config (an app-update.yml) for a
 * test feed; packaged builds ignore that variable.
 */
export class BrowserUpdater {
  onChange: (state: UpdateState) => void = () => {}
  private current: UpdateState = { status: 'idle', release: null, progress: null, error: null, checkedAt: null, updatedFrom: null }
  private readonly updater: AppUpdater | null = null
  private readonly hooks: UpdaterHooks

  constructor(hooks: UpdaterHooks) {
    this.hooks = hooks
    const testConfig = app.isPackaged ? undefined : process.env.ORBIT_UPDATE_CONFIG
    const reason = !app.isPackaged && !testConfig ? 'Updates are delivered to installed copies of Orbit. This is a development build.'
      : process.platform !== 'win32' ? 'Automatic updates are available for the Windows installer.'
        : app.isPackaged && !existsSync(path.join(process.resourcesPath, 'app-update.yml')) ? 'This copy of Orbit was built without an update feed.'
          : null
    if (reason) {
      this.current = { ...this.current, status: 'unsupported', reason }
      return
    }

    const updater = electronUpdater.autoUpdater
    updater.logger = {
      info: (message?: unknown) => console.log('[updater]', message),
      warn: (message?: unknown) => console.warn('[updater]', message),
      error: (message?: unknown) => console.error('[updater]', message),
    }
    // The user starts the download; nothing is fetched beyond the small update manifest until then.
    updater.autoDownload = false
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    // Orbit ships full installers only; refuse a manifest that points at a web installer.
    updater.disableWebInstaller = true
    // A downloaded update the user never restarts for is installed when Orbit next quits. A test
    // feed serves a placeholder file, which must never be run as an installer.
    updater.autoInstallOnAppQuit = !testConfig
    if (testConfig) {
      updater.forceDevUpdateConfig = true
      updater.updateConfigPath = testConfig
    }
    updater.on('download-progress', (progress: ProgressInfo) => {
      if (this.current.status !== 'downloading') return
      this.set({ progress: { percent: Math.max(0, Math.min(100, progress.percent)), transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond } })
    })
    // Every failing call is awaited where it is made, which records the error. An 'error' event
    // without a listener would instead throw in the main process.
    updater.on('error', (error: Error) => {
      console.warn('[updater]', error.message)
      if (this.current.status !== 'installing') return
      this.set({ status: 'error', error: "The update couldn't be installed. Download it again to retry.", release: null })
      this.hooks.installFailed()
    })
    this.updater = updater
  }

  get state(): UpdateState {
    return this.current
  }

  start(): void {
    this.set({ updatedFrom: this.recordLaunch() })
    if (!this.updater) return
    const schedule = (delay: number) => {
      setTimeout(() => { void this.runCheck(false).finally(() => schedule(CHECK_INTERVAL_MS)) }, delay)
    }
    schedule(FIRST_CHECK_DELAY_MS)
  }

  async check(): Promise<UpdateState> {
    await this.runCheck(true)
    return this.current
  }

  async download(): Promise<void> {
    if (!this.updater || !this.current.release || (this.current.status !== 'available' && this.current.status !== 'error')) return
    this.set({ status: 'downloading', error: null, progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } })
    try {
      // Verified against the sha512 in the release's latest.yml before it is reported as downloaded.
      await this.updater.downloadUpdate()
      this.set({ status: 'downloaded', progress: null })
    } catch (error) {
      console.warn('[updater] Download failed:', error)
      this.set({ status: 'error', progress: null, error: describeError(error, 'download') })
    }
  }

  async install(): Promise<void> {
    if (!this.updater || this.current.status !== 'downloaded') return
    this.set({ status: 'installing' })
    try {
      await this.hooks.beforeInstall()
    } catch (error) {
      console.warn('[updater] Pre-install cleanup failed:', error)
    }
    // Silent: an update reuses the existing install's folder and options. Force-run reopens Orbit
    // once the installer finishes, which is the "restart" the user agreed to.
    this.updater.quitAndInstall(true, true)
  }

  /**
   * Interactive checks show their progress and errors. Background checks only ever surface a
   * newer release: a failure while the user is offline is not worth interrupting them for.
   */
  private async runCheck(interactive: boolean): Promise<void> {
    const { status } = this.current
    if (!this.updater || status === 'checking' || status === 'downloading' || status === 'downloaded' || status === 'installing') return
    if (!interactive && status === 'error') return
    if (interactive) this.set({ status: 'checking', error: null })
    try {
      const result = await this.updater.checkForUpdates()
      const info: UpdateInfo | undefined = result?.updateInfo
      if (result?.isUpdateAvailable && info) {
        this.set({ status: 'available', error: null, checkedAt: Date.now(), release: { version: info.version, runtime: readVersions((info as UpdateInfo & { vendor?: unknown }).vendor) } })
      } else {
        this.set({ status: 'up-to-date', error: null, checkedAt: Date.now(), release: null })
      }
    } catch (error) {
      if (isNoRelease(error)) {
        console.log('[updater] No Orbit release is published on the feed yet; nothing newer to install.')
        this.set({ status: 'up-to-date', error: null, checkedAt: Date.now(), release: null })
        return
      }
      console.warn('[updater] Update check failed:', error)
      if (interactive) this.set({ status: 'error', error: describeError(error, 'check'), release: null })
    }
  }

  /** Remembers this launch's versions and returns the previous launch's when Orbit has changed since. */
  private recordLaunch(): RuntimeVersions | null {
    // Dev runs share the installed app's profile; their versions would read as an update.
    if (!this.updater) return null
    const file = path.join(app.getPath('userData'), 'runtime-versions.json')
    const now = runtimeVersions(app.getVersion())
    let previous: Partial<RuntimeVersions> = {}
    try { previous = readVersions(JSON.parse(readFileSync(file, 'utf8'))) } catch { /* First launch with the updater. */ }
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(now), 'utf8')
      renameSync(`${file}.tmp`, file)
    } catch (error) { console.warn('[updater] Could not record runtime versions:', error) }
    const complete = RUNTIME_KEYS.every((key) => previous[key])
    return complete && previous.orbit !== now.orbit ? previous as RuntimeVersions : null
  }

  private set(patch: Partial<UpdateState>): void {
    this.current = { ...this.current, ...patch }
    this.onChange(this.current)
  }
}
