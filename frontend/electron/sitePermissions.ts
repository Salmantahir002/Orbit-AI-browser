import { randomUUID } from 'node:crypto'
import type { Session, WebContents } from 'electron'
import type { PermissionPrompt, SitePermission } from './browserUITypes.js'

type Details = { isMainFrame: boolean; requestingUrl?: string; securityOrigin?: string; embeddingOrigin?: string; mediaTypes?: string[]; mediaType?: string }
type Callback = (allow: boolean) => void
type Pending = { prompt: PermissionPrompt; contents: WebContents; document: string; callbacks: Callback[] }
const SIMPLE: Record<string, SitePermission> = {
  geolocation: 'geolocation', notifications: 'notifications', 'clipboard-read': 'clipboard-read',
  'deprecated-sync-clipboard-read': 'clipboard-read', 'clipboard-sanitized-write': 'clipboard-write',
  fullscreen: 'fullscreen', pointerLock: 'pointerLock', 'idle-detection': 'idle-detection',
  midi: 'midi', midiSysex: 'midiSysex', 'speaker-selection': 'speaker-selection',
  keyboardLock: 'keyboardLock', 'window-management': 'window-management',
}

export function websiteOrigin(url: string | undefined): string | null {
  try { const parsed = new URL(url ?? ''); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.origin : null } catch { return null }
}

function kinds(permission: string, details: Details, check: boolean): SitePermission[] {
  if (permission !== 'media') return Object.hasOwn(SIMPLE, permission) ? [SIMPLE[permission]] : []
  const types = check ? [details.mediaType] : details.mediaTypes
  if (!types?.length || types.some((type) => type !== 'audio' && type !== 'video')) return []
  return [...new Set(types.map((type) => type === 'video' ? 'camera' : 'microphone'))].sort() as SitePermission[]
}

/** One owner for each browsing session. No grants are persisted to disk. */
export class SitePermissions {
  aiMicrophone?: { owns(contents: WebContents): boolean; check(contents: WebContents): boolean; request(contents: WebContents): Promise<boolean> }
  private readonly installed = new WeakSet<Session>()
  private readonly tabs = new Map<number, WebContents>()
  private readonly documents = new Map<number, number>()
  private readonly decisions = new Map<string, boolean>()
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly present: (prompt: PermissionPrompt) => boolean, private readonly dismiss: (prompt: PermissionPrompt) => void) {}

  install(session: Session): void {
    if (this.installed.has(session)) return
    this.installed.add(session)
    session.setPermissionCheckHandler((contents, permission, origin, details) => this.check(contents, permission, origin, details))
    session.setPermissionRequestHandler((contents, permission, callback, details) => this.request(contents, permission, callback, details))
    // Device/file/storage permissions require resource-specific approval and are unsupported.
    session.setDevicePermissionHandler(() => false)
    session.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  }

  attach(contents: WebContents): void {
    this.install(contents.session)
    this.tabs.set(contents.id, contents)
    this.documents.set(contents.id, 0)
    const documentChanged = () => { this.documents.set(contents.id, (this.documents.get(contents.id) ?? 0) + 1); this.cancel(contents.id) }
    contents.on('did-start-navigation', (event) => { if (event.isMainFrame && !event.isSameDocument) documentChanged() })
    // The outgoing document can request again while a slow navigation is in flight.
    // Cancel those requests too when the replacement actually commits.
    contents.on('did-navigate', documentChanged)
    contents.on('render-process-gone', () => this.cancel(contents.id))
    contents.once('destroyed', () => { this.cancel(contents.id); this.tabs.delete(contents.id); this.documents.delete(contents.id) })
  }

  private origin(contents: WebContents | null, details: Details, requested: string | undefined): string | null {
    if (!contents || contents.isDestroyed() || this.tabs.get(contents.id) !== contents || !details || details.isMainFrame !== true) return null
    const top = websiteOrigin(contents.getURL())
    const origin = websiteOrigin(requested)
    if (!top || origin !== top) return null
    if (details.requestingUrl !== undefined && websiteOrigin(details.requestingUrl) !== origin) return null
    if (details.securityOrigin !== undefined && websiteOrigin(details.securityOrigin) !== origin) return null
    if (details.embeddingOrigin !== undefined && websiteOrigin(details.embeddingOrigin) !== origin) return null
    return origin
  }

  private key(origin: string, permission: SitePermission): string { return `${origin}\n${permission}` }
  private document(contents: WebContents): string {
    return `${contents.mainFrame.processId}:${contents.mainFrame.routingId}:${this.documents.get(contents.id)}`
  }

  check(contents: WebContents | null, permission: string, requested: string, details: Details): boolean {
    if (contents && this.aiMicrophone?.owns(contents)) return permission === 'media' && details.isMainFrame === true && details.mediaType === 'audio' && this.aiMicrophone.check(contents)
    const origin = this.origin(contents, details, requested)
    const permissions = origin ? kinds(permission, details, true) : []
    return !!origin && permissions.length > 0 && permissions.every((kind) => this.decisions.get(this.key(origin, kind)) === true)
  }

  request(contents: WebContents, permission: string, callback: Callback, details: Details): void {
    if (this.aiMicrophone?.owns(contents)) {
      if (permission !== 'media' || details.isMainFrame !== true || details.mediaTypes?.length !== 1 || details.mediaTypes[0] !== 'audio') { callback(false); return }
      void this.aiMicrophone.request(contents).then(callback, () => callback(false))
      return
    }
    const origin = this.origin(contents, details, details?.requestingUrl)
    const permissions = origin ? kinds(permission, details, false) : []
    if (!origin || !permissions.length) { callback(false); return }
    const known = permissions.map((kind) => this.decisions.get(this.key(origin, kind)))
    if (known.includes(false)) { callback(false); return }
    if (known.every((allow) => allow === true)) { callback(true); return }
    const existing = this.pending.get(contents.id)
    const document = this.document(contents)
    if (existing) {
      if (existing.document === document && existing.prompt.origin === origin && existing.prompt.permissions.join() === permissions.join() && existing.callbacks.length < 16) existing.callbacks.push(callback)
      else callback(false)
      return
    }
    const prompt = { id: randomUUID(), targetId: contents.id, origin, permissions }
    this.pending.set(contents.id, { prompt, contents, document, callbacks: [callback] })
    try { if (!this.present(prompt)) this.finish(contents.id, false, false) } catch { this.finish(contents.id, false, false) }
  }

  decide(id: string, targetId: number, allow: boolean): void {
    const pending = this.pending.get(targetId)
    if (!pending || pending.prompt.id !== id) return
    const valid = !pending.contents.isDestroyed() && this.tabs.get(targetId) === pending.contents && this.document(pending.contents) === pending.document && websiteOrigin(pending.contents.getURL()) === pending.prompt.origin
    this.finish(targetId, valid && allow, valid)
  }

  cancel(targetId: number): void { this.finish(targetId, false, false) }

  private finish(targetId: number, allow: boolean, remember: boolean): void {
    const pending = this.pending.get(targetId)
    if (!pending) return
    this.pending.delete(targetId) // Remove before callbacks; they may synchronously request again.
    if (remember) for (const kind of pending.prompt.permissions) this.decisions.set(this.key(pending.prompt.origin, kind), allow)
    this.dismiss(pending.prompt)
    for (const callback of pending.callbacks) { try { callback(allow) } catch { /* A destroyed renderer must not strand another callback. */ } }
  }
}
