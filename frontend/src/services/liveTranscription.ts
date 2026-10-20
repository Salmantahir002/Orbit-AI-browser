import workletUrl from '../audio/pcmCapture.worklet.js?url&no-inline'
import type { AiAudioBridge } from '../../electron/aiAudioTypes'
import { audioErrorMessage } from '../utils/audioErrorMessage'

export type RecordingState = 'idle' | 'connecting' | 'recording' | 'stopping'

/** One owner for every resource acquired by a recording, including cancelled async starts. */
export class LiveTranscription {
  readonly id = crypto.randomUUID()
  private cancelled = false
  private stopping = false
  private stream?: MediaStream
  private context?: AudioContext
  private source?: MediaStreamAudioSourceNode
  private node?: AudioWorkletNode
  private unsubscribe?: () => void
  private flushed?: () => void
  private bridge: AiAudioBridge
  private callbacks: { text: (delta: string) => void; state: (state: RecordingState) => void; error: (message: string) => void }

  constructor(callbacks: { text: (delta: string) => void; state: (state: RecordingState) => void; error: (message: string) => void }) {
    this.callbacks = callbacks
    const bridge = window.electronAPI?.aiAudio
    if (!bridge) throw new Error('Open Orbit to use live transcription.')
    this.bridge = bridge
  }

  async start(): Promise<void> {
    this.callbacks.state('connecting')
    this.unsubscribe = this.bridge.onEvent((event) => {
      if ((event.sessionId !== this.id && event.sessionId !== '*') || this.cancelled) return
      if (event.type === 'text' && event.text !== undefined) this.callbacks.text(event.text)
      else if (event.type === 'closed' || event.type === 'error' || event.type === 'revoked') {
        if (event.message) this.callbacks.error(event.message)
        if (event.type === 'revoked') this.callbacks.error('Microphone access was revoked. Click the microphone to request approval again.')
        void this.stop(true)
      }
    })
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false })
      if (this.cancelled) { stream.getTracks().forEach((track) => track.stop()); return }
      this.stream = stream
      for (const track of stream.getTracks()) track.addEventListener('ended', () => {
        if (!this.cancelled) { this.callbacks.error('The microphone disconnected. Your transcript has been kept.'); void this.stop(true) }
      })
      const context = new AudioContext()
      this.context = context
      await context.audioWorklet.addModule(workletUrl)
      if (this.cancelled) return
      const node = new AudioWorkletNode(context, 'orbit-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      this.node = node
      node.port.onmessage = ({ data }) => {
        if (data === 'flushed') this.flushed?.()
        else if (!this.cancelled && data instanceof ArrayBuffer) this.bridge.send(this.id, data)
      }
      node.onprocessorerror = () => { this.callbacks.error('Audio processing stopped. Please reconnect the microphone.'); void this.stop(true) }
      await this.bridge.start(this.id)
      if (this.cancelled) { await this.bridge.stop(this.id, true); return }
      const source = context.createMediaStreamSource(stream)
      this.source = source
      const mute = context.createGain()
      mute.gain.value = 0
      source.connect(node).connect(mute).connect(context.destination)
      await context.resume()
      if (!this.cancelled) this.callbacks.state('recording')
    } catch (error) {
      if (!this.cancelled) {
        this.callbacks.error(error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone access was declined. Click the microphone to request approval again. If Windows blocked access, allow it in Windows microphone settings.'
          : audioErrorMessage(error))
        await this.stop(true)
      }
    }
  }

  async stop(cancel = false): Promise<void> {
    if (this.cancelled || this.stopping) return
    this.stopping = true
    if (cancel) this.cancelled = true
    this.callbacks.state('stopping')
    // Stop hardware capture immediately, while allowing queued transcript messages to drain.
    this.stream?.getTracks().forEach((track) => track.stop())
    if (!cancel && this.node) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 150)
        this.flushed = () => { clearTimeout(timer); resolve() }
        this.node!.port.postMessage('flush')
      })
    }
    this.source?.disconnect()
    this.node?.disconnect()
    this.node?.port.close()
    if (this.context?.state !== 'closed') await this.context?.close().catch(() => {})
    if (cancel) this.cancelled = true
    try { await this.bridge.stop(this.id, cancel) } catch { /* Main may already have closed. */ }
    this.cancelled = true
    this.unsubscribe?.()
    this.callbacks.state('idle')
  }
}
