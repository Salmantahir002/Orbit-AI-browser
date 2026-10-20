import { useEffect, useRef, useState } from 'react'
import { LiveTranscription, type RecordingState } from '../services/liveTranscription'

export function useLiveTranscription(value: string, setValue: (value: string) => void, resetSignal?: unknown) {
  const [state, setState] = useState<RecordingState>('idle')
  const [error, setError] = useState('')
  const current = useRef({ value, setValue })
  useEffect(() => { current.current = { value, setValue } }, [value, setValue])
  const recording = useRef<LiveTranscription | null>(null)
  const wordTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  useEffect(() => () => { const session = recording.current; recording.current = null; clearInterval(wordTimer.current); void session?.stop(true) }, [resetSignal])
  async function toggle() {
    if (recording.current && state !== 'idle') { await recording.current.stop(state === 'connecting'); return }
    setError('')
    let text = current.current.value
    const original = text
    const words: string[] = []
    try {
      const session = new LiveTranscription({
        state: (next) => {
          if (recording.current !== session) { if (next === 'idle' && !recording.current) setState('idle'); return }
          if (next === 'idle') { clearInterval(wordTimer.current); text += words.splice(0).join(''); current.current.setValue(text) }
          setState(next)
        },
        error: (message) => { if (recording.current === session) setError(message) },
        text: (transcript) => {
          if (recording.current !== session) return
          const desired = original + (original && transcript && !/\s$/.test(original) && !/^\s/.test(transcript) ? ' ' : '') + transcript
          let common = 0
          while (common < text.length && common < desired.length && text[common] === desired[common]) common++
          text = text.slice(0, common)
          words.splice(0, words.length, ...(desired.slice(common).match(/\s*\S+|\s+$/g) || []))
          current.current.setValue(text)
          if (!wordTimer.current) wordTimer.current = setInterval(() => {
            if (recording.current !== session) return
            if (words.length) { text += words.shift(); current.current.setValue(text) }
          }, 30)
        },
      })
      recording.current = session
      clearInterval(wordTimer.current)
      wordTimer.current = undefined
      await session.start()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not start recording.'); setState('idle') }
  }
  return { state, error, busy: state !== 'idle', toggle }
}
