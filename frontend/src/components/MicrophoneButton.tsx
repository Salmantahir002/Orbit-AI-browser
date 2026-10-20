import { Mic, Square, LoaderCircle } from 'lucide-react'
import type { RecordingState } from '../services/liveTranscription'
import './MicrophoneButton.css'

export function MicrophoneButton({ state, disabled, onClick }: { state: RecordingState; disabled?: boolean; onClick: () => void }) {
  const active = state !== 'idle'
  const label = state === 'idle' ? 'Start voice input' : state === 'connecting' ? 'Cancel voice input' : state === 'stopping' ? 'Finalizing voice input' : 'Stop voice input'
  return <button type="button" className={`prompt-icon-btn ai-mic-button${active ? ' ai-mic-button--active' : ''}`} aria-label={label} title={label} aria-pressed={active} disabled={disabled || state === 'stopping'} onClick={onClick}>
    {state === 'connecting' || state === 'stopping' ? <LoaderCircle size={17} aria-hidden="true" /> : active ? <Square size={15} fill="currentColor" aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
  </button>
}

export function MicrophoneStatus({ state, error }: { state: RecordingState; error: string }) {
  if (error) return <p className="ai-mic-status ai-mic-error" role="alert">{error}</p>
  if (state === 'idle') return null
  return <p className="ai-mic-status" role="status">{state === 'recording' ? 'Listening · audio is sent to Google Gemini. Stop to edit or send.' : state === 'connecting' ? 'Waiting for microphone approval / connecting…' : 'Finalizing transcript…'}</p>
}
