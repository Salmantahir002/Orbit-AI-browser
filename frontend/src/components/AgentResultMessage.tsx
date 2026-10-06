import { useMemo } from 'react'
import { MarkdownMessage } from './MarkdownMessage'
import './AgentResultMessage.css'

function prettyJson(text: string): string | null {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
  const candidate = (fenced?.[1] ?? trimmed).trim()
  if (!candidate.startsWith('{') && !candidate.startsWith('[')) return null
  try {
    return JSON.stringify(JSON.parse(candidate), null, 2)
  } catch {
    // Do not silently repair or discard malformed model output.
    return null
  }
}

export function AgentResultMessage({ text, expanded = false }: { text: string; expanded?: boolean }) {
  const json = useMemo(() => prettyJson(text), [text])
  if (json !== null) {
    return (
      <pre
        className={`agent-result-json${expanded ? ' agent-result-json--expanded' : ''}`}
        tabIndex={0}
        aria-label="Formatted JSON result"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
      ><code>{json}</code></pre>
    )
  }
  return expanded
    ? <MarkdownMessage text={text} className="agent-result-modal-markdown" />
    : <p>{text}</p>
}
