import { useState } from 'react'
import type { ClientProviderConfig } from '../types/providerTypes'
import type { TranscribeModel } from '../../electron/aiAudioTypes'
import { audioErrorMessage } from '../utils/audioErrorMessage'
import { LiquidGlass } from './LiquidGlass'
import './MicrophoneButton.css'

export function AudioTranscribeSettings({ config, onChange }: {
  config: ClientProviderConfig
  onChange: (value: { transcribe_model: string; transcribe_models: TranscribeModel[] }) => void | Promise<void>
}) {
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  async function run(operation: 'fetch' | 'test') {
    setBusy(operation); setError(''); setMessage('')
    try {
      const bridge = window.electronAPI?.aiAudio
      if (!bridge) throw new Error('Open Orbit to configure audio.')
      if (operation === 'fetch') {
        const models = await bridge.fetchModels(config)
        await onChange({ transcribe_models: models, transcribe_model: models.some((model) => model.id === config.transcribe_model) ? config.transcribe_model! : models[0]?.id || '' })
        setMessage(models.length ? `${models.length} live transcription model${models.length === 1 ? '' : 's'} available.` : 'No Live audio models are available for this API key. Check Gemini model access.')
      } else setMessage((await bridge.testConnection(config)).message)
    } catch (err) { setError(audioErrorMessage(err)) }
    finally { setBusy('') }
  }
  return <section className="ai-audio-settings" aria-label="Audio Transcribe Settings">
    <h3>Audio Transcribe Settings</h3>
    {config.is_audio_provider && config.transcribe_model ? <span className="oc-badge oc-badge--active">Used for voice input</span> : null}
    <p>Use this Gemini API key for live voice input in Chat and Agent. Audio Providers uses this same saved selection.</p>
    <div className="oc-action-row">
      <button type="button" className="oc-btn-secondary lg-host" disabled={!!busy} onClick={() => { void run('fetch') }}><LiquidGlass refraction={0} blur={5} elasticity={0.16} /><span>{busy === 'fetch' ? 'Fetching Transcribe Models…' : 'Fetch Transcribe Models'}</span></button>
      <button type="button" className="oc-btn-secondary lg-host" disabled={!!busy || !config.transcribe_model} onClick={() => { void run('test') }}><LiquidGlass refraction={0} blur={5} elasticity={0.16} /><span>{busy === 'test' ? 'Testing Audio Connection…' : 'Test Audio Connection'}</span></button>
    </div>
    <label className="oc-form-group"><span className="oc-label">Live transcription model</span>
      <select className="oc-select" value={config.transcribe_model || ''} disabled={!!busy} onChange={(event) => {
        setError(''); setMessage('')
        void Promise.resolve(onChange({ transcribe_model: event.target.value, transcribe_models: config.transcribe_models || [] })).catch((err) => setError(audioErrorMessage(err)))
      }}>
        <option value="">Select a fetched live model</option>
        {(config.transcribe_models || []).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select>
    </label>
    {message ? <p role="status">{message}</p> : null}
    {error ? <p className="ai-mic-error" role="alert">{error}</p> : null}
  </section>
}
