import { GlassSwitch, type GlassSwitchOption } from './GlassSwitch'

export type AssistantMode = 'chat' | 'agent'

const MODES: Array<GlassSwitchOption<AssistantMode>> = [
  { id: 'chat', label: 'Chat' },
  { id: 'agent', label: 'Agent' },
]

type Props = {
  mode: AssistantMode
  onChange: (mode: AssistantMode) => void
}

/** The assistant's Chat/Agent switch: a glass capsule with a glass lens (see GlassSwitch). */
export function GlassModeSwitch({ mode, onChange }: Props) {
  return <GlassSwitch options={MODES} value={mode} onChange={onChange} ariaLabel="Assistant mode" classPrefix="assistant-mode" />
}
