import { Maximize2, Minimize2 } from 'lucide-react'

type PromptExpandButtonProps = {
  expanded: boolean
  controls: string
  onToggle: () => void
}

export function PromptExpandButton({ expanded, controls, onToggle }: PromptExpandButtonProps) {
  const label = expanded ? 'Minimize prompt box' : 'Maximize prompt box'
  const Icon = expanded ? Minimize2 : Maximize2
  return (
    <button
      type="button"
      className="prompt-expand-button"
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
    </button>
  )
}
