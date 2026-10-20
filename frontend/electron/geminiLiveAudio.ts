import { dialog, type BrowserWindow, type WebContents } from 'electron'
import { GoogleGenAI, type LiveServerMessage } from '@google/genai'
import { providerSecureStore, type ProviderSaveRequest } from './providerSecureStore.js'
import type { AudioEvent, TranscribeModel } from './aiAudioTypes.js'

// Factory kept separate from capture/permission logic so transport can be exercised with a local server.
export const geminiAudioClient = { create: (apiKey: string) => new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta', timeout: 15_000 } }) }
export const geminiAudioTransport = { open: (apiKey: string) => new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`) }
type LiveSession = { sendRealtimeInput(input: unknown): void; close(): void }
type Stream = { id: string; owner: WebContents; session?: LiveSession; closed: boolean; stopping: boolean; transcript: string; finish?: () => void; abort?: () => void }

export class GeminiLiveAudio {
  private streams = new Map<number, Stream>()
  private grants = new Set<number>()
  private epoch = 0
  private prompts = new Set<number>()

  constructor(private options: {
    windowFor: (contents: WebContents) => BrowserWindow | undefined
    allowed: () => boolean
    setAllowed: (allow: boolean) => void
  }) {}

  check(contents: WebContents): boolean { return this.options.allowed() && this.grants.has(contents.id) }

  async request(contents: WebContents): Promise<boolean> {
    const window = this.options.windowFor(contents)
    if (!window || this.prompts.has(contents.id)) return false
    if (this.check(contents)) return true
    this.prompts.add(contents.id)
    const epoch = this.epoch
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'question', title: 'Microphone access for AI features',
        message: 'Allow Orbit to use your microphone?',
        detail: 'While recording, your audio is sent to Google Gemini to transcribe into Chat or Agent. You can stop recording or revoke access in Settings → Privacy.',
        buttons: ['Allow microphone', 'Don’t allow'], defaultId: 1, cancelId: 1, noLink: true,
      })
      if (response !== 0 || epoch !== this.epoch || contents.isDestroyed()) return false
      this.options.setAllowed(true)
      this.grants.add(contents.id)
      return true
    } finally { this.prompts.delete(contents.id) }
  }

  revoke(): void {
    this.epoch++
    this.grants.clear()
    for (const stream of this.streams.values()) {
      this.emit(stream, { type: 'revoked' })
      this.close(stream)
    }
  }

  detach(contents: WebContents): void {
    this.grants.delete(contents.id)
    const stream = this.streams.get(contents.id)
    if (stream) this.close(stream)
  }

  async fetchModels(config: ProviderSaveRequest): Promise<TranscribeModel[]> {
    const { apiKey } = providerSecureStore.resolveAudioCandidate(config)
    try {
      const client = geminiAudioClient.create(apiKey)
      const pager = await client.models.list({ config: { pageSize: 100 } })
      const models: TranscribeModel[] = []
      for await (const model of pager) {
        const actions = model.supportedActions ?? []
        const live = actions.some((action) => /bidiGenerateContent|live|transcrib/i.test(action))
        // Some API versions omit capabilities. Only then use the returned model's live-audio name.
        const name = model.name ?? ''
        if (!name || (!live && (actions.length > 0 || !/live|native.audio/i.test(name)))) continue
        models.push({ id: name.replace(/^models\//, ''), name: model.displayName || name,
          description: model.description, responseModality: /transcrib/i.test(name) ? 'TEXT' : 'AUDIO' })
      }
      return models
    } catch { throw new Error('Could not fetch Gemini Live models. Check your API key and connection.') }
  }

  private emit(stream: Stream, event: Omit<AudioEvent, 'sessionId'>): void {
    if (!stream.owner.isDestroyed()) stream.owner.send('ai-audio:event', { ...event, sessionId: stream.id })
  }

  private close(stream: Stream): void {
    if (stream.closed) return
    stream.closed = true
    stream.abort?.()
    stream.finish?.()
    stream.session?.close()
    if (this.streams.get(stream.owner.id) === stream) this.streams.delete(stream.owner.id)
    this.emit(stream, { type: 'closed' })
  }

  private async connect(config: ProviderSaveRequest | undefined, onmessage: (message: LiveServerMessage) => void, onfailure: () => void, stream?: Stream): Promise<LiveSession> {
    const { apiKey, model, models } = providerSecureStore.resolveAudioCandidate(config)
    if (!model || !models.some((item) => item.id === model)) throw new Error('Fetch and select a transcription model in Google Gemini settings first.')
    const socket = geminiAudioTransport.open(apiKey)
    socket.binaryType = 'arraybuffer'
    let ready = false
    let closed = false
    return new Promise((resolve, reject) => {
      const close = () => { closed = true; clearTimeout(timer); socket.close() }
      const fail = () => {
        if (closed) return
        close()
        if (ready) onfailure()
        else reject(new Error('Gemini Live connection failed. Check your API key, model access, quota, and connection.'))
      }
      const timer = setTimeout(fail, 15_000)
      if (stream) stream.abort = () => { if (!ready) { close(); reject(new Error('Recording was cancelled.')) } }
      socket.addEventListener('open', () => {
        if (closed) return
        socket.send(JSON.stringify({ setup: {
          model: model.startsWith('models/') ? model : `models/${model}`,
          generationConfig: { responseModalities: [models.find((item) => item.id === model)?.responseModality || 'AUDIO'] },
          inputAudioTranscription: {},
        } }))
      })
      socket.addEventListener('message', (event) => {
        if (closed) return
        try {
          const message = JSON.parse(event.data instanceof ArrayBuffer ? Buffer.from(event.data).toString('utf8') : String(event.data)) as LiveServerMessage & { error?: unknown }
          if (message.error) { fail(); return }
          if (message.setupComplete && !ready) {
            ready = true; clearTimeout(timer)
            resolve({ close, sendRealtimeInput: (input) => {
              if (closed || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256_000) { fail(); throw new Error('Audio connection is unavailable or too slow.') }
              socket.send(JSON.stringify({ realtimeInput: input }))
            } })
          }
          onmessage(message)
        } catch { fail() }
      })
      socket.addEventListener('error', fail)
      socket.addEventListener('close', fail)
    })
  }

  async testConnection(config: ProviderSaveRequest): Promise<{ message: string }> {
    let failed = false
    const session = await this.connect(config, () => {}, () => { failed = true })
    try {
      session.sendRealtimeInput({ audio: { data: Buffer.alloc(3200).toString('base64'), mimeType: 'audio/pcm;rate=16000' } })
      session.sendRealtimeInput({ audioStreamEnd: true })
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (failed) throw new Error('Gemini rejected the audio stream. Check this model’s Live API access.')
      return { message: 'Live audio connection succeeded. Microphone transcription is ready to try.' }
    } finally { session.close() }
  }

  async start(owner: WebContents, id: string): Promise<void> {
    if (!this.check(owner)) throw new Error('Microphone approval is required. Click the microphone to request access again.')
    if (!/^[\w-]{1,100}$/.test(id)) throw new Error('Invalid audio session.')
    // A new session supersedes the previous one, including a pending connection.
    const old = this.streams.get(owner.id)
    if (old) this.close(old)
    const stream: Stream = { id, owner, closed: false, stopping: false, transcript: '' }
    this.streams.set(owner.id, stream)
    try {
      const session = await this.connect(undefined, (message) => {
        if (stream.closed) return
        const content = message.serverContent as (LiveServerMessage['serverContent'] & { interimInputTranscription?: { text?: string } })
        if (content?.inputTranscription) stream.transcript += content.inputTranscription.text || ''
        // Interim hypotheses replace each other. Only finalized input is committed, so revisions
        // cannot duplicate words. Model-generated answers never enter the user's composer.
        if (content?.inputTranscription || content?.interimInputTranscription) this.emit(stream, {
          type: 'text', text: stream.transcript + (content.interimInputTranscription?.text || ''),
        })
        if (message.serverContent?.turnComplete && stream.stopping) stream.finish?.()
        if (message.goAway) { this.emit(stream, { type: 'error', message: 'The audio session expired. Click the microphone to reconnect.' }); this.close(stream) }
      }, () => {
        if (!stream.closed) { this.emit(stream, { type: 'error', message: 'The audio connection closed. Your transcript has been kept.' }); this.close(stream) }
      }, stream)
      stream.session = session
      if (stream.closed || !this.check(owner)) { session.close(); throw new Error('Recording was cancelled.') }
    } catch (error) {
      if (!stream.closed) this.emit(stream, { type: 'error', message: error instanceof Error ? error.message : 'Could not start audio transcription.' })
      this.close(stream)
      throw error
    }
  }

  send(owner: WebContents, id: string, pcm: unknown): void {
    const stream = this.streams.get(owner.id)
    if (!stream || stream.id !== id || stream.closed || stream.stopping || !this.check(owner)) return
    if (!(pcm instanceof ArrayBuffer) || pcm.byteLength === 0 || pcm.byteLength > 6400 || pcm.byteLength % 2) return
    try { stream.session?.sendRealtimeInput({ audio: { data: Buffer.from(pcm).toString('base64'), mimeType: 'audio/pcm;rate=16000' } }) }
    catch { this.emit(stream, { type: 'error', message: 'Audio could not be sent. Please reconnect.' }); this.close(stream) }
  }

  async stop(owner: WebContents, id: string, cancel = false): Promise<void> {
    const stream = this.streams.get(owner.id)
    if (!stream || stream.id !== id) return
    if (cancel || !stream.session) { this.close(stream); return }
    stream.stopping = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve) => {
        stream.finish = resolve
        timer = setTimeout(resolve, 1800)
        stream.session!.sendRealtimeInput({ audioStreamEnd: true })
      })
    } finally { clearTimeout(timer); this.close(stream) }
  }
}
