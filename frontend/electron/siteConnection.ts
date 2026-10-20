import type { WebContents } from 'electron'
import type { CdpParams, CdpSession } from './browserRuntime/cdpSession.js'
import type { ConnectionInfo } from './browserUITypes.js'

export function initialConnection(url: string): ConnectionInfo {
  try {
    const protocol = new URL(url).protocol
    return { url, status: protocol === 'http:' ? 'http' : protocol === 'https:' ? 'checking' : ['about:', 'file:', 'data:', 'blob:', 'orbit:'].includes(protocol) ? 'internal' : 'unavailable' }
  } catch { return { url, status: 'unavailable' } }
}

/** A URL can select an initial warning, but only Chromium's TLS evidence can select encrypted. */
export class SiteConnection {
  state: ConnectionInfo = initialConnection('about:blank')
  private loader = ''
  private responses = new Map<string, { url: string; verified: boolean }>()
  private warning: ConnectionInfo | null = null

  private readonly publish: (state: ConnectionInfo) => void
  constructor(publish: (state: ConnectionInfo) => void) { this.publish = publish }
  private update(state: ConnectionInfo): void { this.state = state; this.publish(state) }
  navigate(url: string): void { this.loader = ''; this.responses.clear(); this.warning = null; this.update(initialConnection(url)) }
  fail(url: string, detail: string, certificate = false): void {
    this.warning = { url, status: certificate ? 'certificate-error' : 'unavailable', detail }
    this.update(this.warning)
  }
  unavailable(): void { this.fail(this.state.url, 'Chromium connection information is unavailable.') }
  private insecure(): void {
    if (this.warning?.status === 'certificate-error') return
    this.warning = { url: this.state.url, status: 'insecure', detail: 'Chromium reported insecure content or a connection security issue.' }
    this.update(this.warning)
  }

  event(method: string, params: CdpParams): void {
    if (method === 'Network.responseReceived') {
      const response = params.response as { url?: string; securityState?: string; securityDetails?: { protocol?: string; issuer?: string } } | undefined
      if (typeof params.loaderId !== 'string' || !response?.url) return
      if (params.type !== 'Document') {
        if (this.loader && params.loaderId === this.loader && this.state.url.startsWith('https:') && (response.url.startsWith('http:') || ['insecure', 'insecure-broken'].includes(response.securityState ?? ''))) this.insecure()
        return
      }
      this.responses.set(params.loaderId, { url: response.url, verified: response.securityState === 'secure' && !!response.securityDetails?.protocol && !!response.securityDetails.issuer })
      if (this.responses.size > 32) this.responses.delete(this.responses.keys().next().value!)
      this.apply()
    } else if (method === 'Page.frameNavigated') {
      const frame = params.frame as { parentId?: string; loaderId?: string; url?: string } | undefined
      if (!frame?.url) return
      if (frame.parentId) {
        if (this.loader && this.state.url.startsWith('https:') && frame.url.startsWith('http:')) this.insecure()
        return
      }
      this.loader = frame.loaderId ?? ''
      // Same-document navigations do not replace this loader or reset TLS evidence.
      if (!this.warning) this.update(initialConnection(frame.url))
      this.apply()
    } else if (method === 'Security.visibleSecurityStateChanged') {
      const state = params.visibleSecurityState as { securityState?: string; certificateSecurityState?: { certificateNetworkError?: string }; securityStateIssueIds?: string[] } | undefined
      if (!state || !this.loader || !this.state.url.startsWith('https:')) return
      if (state.certificateSecurityState?.certificateNetworkError) {
        this.fail(this.state.url, state.certificateSecurityState.certificateNetworkError, true)
      } else if (state.securityState === 'insecure' || state.securityState === 'insecure-broken' || state.securityState === 'neutral') {
        this.insecure()
      }
    }
  }

  private apply(): void {
    const response = this.responses.get(this.loader)
    if (!response || this.warning) return
    const initial = initialConnection(response.url)
    this.update(initial.status === 'checking' ? { url: response.url, status: response.verified ? 'encrypted' : 'insecure' } : initial)
  }

  attach(contents: WebContents, session: CdpSession | null): void {
    contents.on('did-start-navigation', (event) => { if (event.isMainFrame && !event.isSameDocument) this.navigate(event.url) })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) this.update({ ...this.state, url }) })
    contents.on('certificate-error', (_event, url, error, _certificate, callback) => {
      this.fail(this.state.url || url, error, true)
      // Never preventDefault or override certificate verification.
      callback(false)
    })
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.fail(url, description, (code <= -200 && code > -300) || this.state.status === 'certificate-error')
    })
    contents.on('render-process-gone', () => this.unavailable())
    contents.debugger.on('detach', () => this.unavailable())
    if (!session) { this.unavailable(); return }
    const stop = session.on((method, params) => this.event(method, params))
    contents.once('destroyed', stop)
    void session.enableDomains(['Page', 'Network', 'Security'])
  }
}
