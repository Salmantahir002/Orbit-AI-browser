/* PCM conversion runs on the audio rendering thread. No microphone playback. */
class OrbitPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / 16000
    this.weight = 0
    this.sum = 0
    this.chunk = new Int16Array(1600)
    this.length = 0
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') {
        this.flush()
        this.port.postMessage('flushed')
      }
    }
  }
  flush() {
    if (!this.length) return
    // Explicit little-endian encoding, independent of the host's byte order.
    const buffer = new ArrayBuffer(this.length * 2)
    const view = new DataView(buffer)
    for (let i = 0; i < this.length; i++) view.setInt16(i * 2, this.chunk[i], true)
    this.port.postMessage(buffer, [buffer])
    this.length = 0
  }
  process(inputs) {
    const channels = inputs[0]
    if (!channels?.length) return true
    for (let i = 0; i < channels[0].length; i++) {
      let mono = 0
      for (const channel of channels) mono += channel[i] / channels.length
      let remaining = 1
      while (remaining > 1e-8) {
        const take = Math.min(remaining, this.ratio - this.weight)
        this.sum += mono * take
        this.weight += take
        remaining -= take
        if (this.weight >= this.ratio - 1e-8) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio))
          this.chunk[this.length++] = Math.round(value * (value < 0 ? 32768 : 32767))
          this.weight = 0
          this.sum = 0
          if (this.length === this.chunk.length) this.flush()
        }
      }
    }
    return true
  }
}
registerProcessor('orbit-pcm-capture', OrbitPcmCapture)
