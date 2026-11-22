import type { PageStateSnapshot, RuntimeCommandName } from './browserRuntimeTypes'

/** Tool names the planner may emit. Mirrors backend `agent_tool_registry.py`. */
export type AgentToolName =
  | 'evaluate'
  | 'element_bounds'
  | 'dispatch_mouse_event'
  | 'drag'
  | 'extract_virtual_table'
  | 'click'
  | 'fill'
  | 'type'
  | 'press_key'
  | 'click_text'
  | 'read_text'
  | 'select_option'
  | 'hover'
  | 'go_back'
  | 'ask_user'
  | 'navigate'
  | 'open_tab'
  | 'scroll'
  | 'upload'
  | 'wait'
  | 'extract'
  | 'finish'

export type AgentToolCall = {
  tool: AgentToolName
  arguments: Record<string, unknown>
  requires_approval?: boolean
}

export type AgentPlanResponse = {
  /** The queued actions. `tool_call` is the first, kept for single-step callers. */
  tool_calls: AgentToolCall[]
  tool_call: AgentToolCall
  confidence: number
  /** True when confidence fell below the backend threshold — pause for the user. */
  needs_user_confirmation: boolean
  reason: string
  thought?: string
  /** The planner's checklist for the whole goal, re-stated every round. */
  progress?: AgentProgressItem[]
  model: string
  planner_mode: 'llm'
}

export type AgentProgressStatus = 'done' | 'in_progress' | 'todo'

export type AgentProgressItem = {
  step: string
  status: AgentProgressStatus
}

/**
 * A record of text the agent itself entered into a page. Kept for the whole
 * task — unlike the rolling step log — because re-typing content that is
 * already there is the one mistake that visibly corrupts the user's document.
 */
export type AgentContentEntry = {
  step: number
  tool: string
  target?: string
  page: string
  chars: number
  head: string
  tail: string
  /** `unverifiable`: keystrokes were delivered but the editor hides its content (canvas editors). */
  status: 'verified' | 'unverifiable' | 'failed'
}

/** One finished task earlier in this app session, for follow-up goals. */
export type AgentSessionTaskRecord = {
  goal: string
  status: string
  outcome: string
  milestones: string[]
  finalUrl: string
}

export type AgentStepRecord = {
  tool: string
  summary: string
  succeeded: boolean
  step?: number
}

/** The agent's up-front analysis of the goal (POST /agent/analyze). */
export type AgentTaskBrief = {
  summary: string
  task_type?: string
  /** Acceptance criteria the finished task is checked against. */
  requirements: string[]
  plan?: string[]
  /** Drafted content to enter (slides, letter, email body). */
  content?: string
  start_url?: string
  risks?: string[]
}

/** What the latest refused self-check said is still missing. */
export type AgentSelfCheckFeedback = {
  attempt: number
  missing: string[]
  next_step?: string
}

export type AgentVerificationCheck = {
  requirement: string
  met: boolean
  evidence: string
}

/** POST /agent/verify — an evidence-based judgement of a finish claim. */
export type AgentVerification = {
  complete: boolean
  checks: AgentVerificationCheck[]
  missing: string[]
  next_step?: string
  confidence: number
  model?: string
}

export type AgentFailureRecord = {
  tool: string
  reason: string
  code?: string
}

/**
 * The planner's entire recollection — a bounded, structured summary rather
 * than a conversation transcript.
 */
export type AgentWorkingMemorySnapshot = {
  goal: string
  completed_steps: AgentStepRecord[]
  pending_steps: string[]
  failures: AgentFailureRecord[]
  retries: number
  current_page: string
  extracted_knowledge?: string[]
  invalid_elements?: string[]
  last_thought?: string
  step_number?: number
  plan_progress?: AgentProgressItem[]
  milestones?: string[]
  content_entered?: AgentContentEntry[]
  session_history?: AgentSessionTaskRecord[]
  task_brief?: AgentTaskBrief
  self_check?: AgentSelfCheckFeedback
}

export type AgentPlanRequest = {
  goal: string
  working_memory: AgentWorkingMemorySnapshot
  page_state: PageStateSnapshot
}

/**
 * A tool call resolved to a concrete Browser Runtime command. `null` means the
 * tool is handled by the agent loop itself rather than by the browser.
 */
export type ResolvedToolCommand = {
  command: RuntimeCommandName
  params: Record<string, unknown>
} | null

export type AgentAbortReason =
  | 'planner_failed'
  | 'action_failed'
  | 'needs_confirmation'
  | 'declined'
  | 'step_limit'
  | 'cancelled'
  | 'blocked'

export type AgentTaskStatus = 'idle' | 'running' | 'completed' | 'failed'

export type AgentTaskResult = {
  taskId: string
  status: AgentTaskStatus
  message: string
  steps: number
  reason?: AgentAbortReason
  /**
   * Completed tasks only: true when the self-check confirmed every requirement,
   * false when the agent finished without that confirmation.
   */
  verified?: boolean
  checks?: AgentVerificationCheck[]
}
