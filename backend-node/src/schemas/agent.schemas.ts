// Port of backend/app/schemas/agent_schemas.py.
// Deliberately separate from security.schemas.ts: the manual-scan contract and the
// agent contract must be able to change independently.
//
// The agent has no security-scan contract: agent mode does not scan pages, and only the
// user-initiated Scan Page button does (POST /security/check-webpage). What is here is the
// LLM-backed planner's contract: AgentPlanRequest/AgentPlanResponse and the
// working-memory/page-state schemas it consumes.
import { Type, type Static } from '@sinclair/typebox'

// ─────────────────────────── Phase 4: planner contract ───────────────────────────
// One actionable element, as produced by the frontend State Builder.
export const AgentSemanticElementSchema = Type.Object({
  id: Type.String(),
  role: Type.String(),
  name: Type.Optional(Type.String()),
  value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  disabled: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  required: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  focused: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  expanded: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  selected: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  checked: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  invalid: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  nearbyText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  placeholder: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  container: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  inputType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  nameAttr: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

export const AgentSemanticDialogSchema = Type.Object({
  id: Type.String(),
  role: Type.String(),
  name: Type.Optional(Type.String()),
  modal: Type.Optional(Type.Boolean()),
})

export const AgentValidationIssueSchema = Type.Object({
  elementId: Type.String(),
  role: Type.String(),
  message: Type.Optional(Type.String()),
})

// A file the browser downloaded earlier in this session. The planner sees an
// id, a name and a size; the path stays in the Electron main process.
export const AgentSessionDownloadSchema = Type.Object({
  id: Type.String(),
  filename: Type.String(),
  sizeBytes: Type.Optional(Type.Number()),
})

// The compact semantic state. The raw accessibility tree never arrives here.
export const AgentPageStateSchema = Type.Object({
  url: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  elements: Type.Optional(Type.Array(AgentSemanticElementSchema)),
  focusedElementId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  dialogs: Type.Optional(Type.Array(AgentSemanticDialogSchema)),
  validationErrors: Type.Optional(Type.Array(AgentValidationIssueSchema)),
  selectedElementIds: Type.Optional(Type.Array(Type.String())),
  truncated: Type.Optional(Type.Boolean()),
  downloads: Type.Optional(Type.Array(AgentSessionDownloadSchema)),
  // Set while the page waits for files (its "Attach" control was clicked).
  fileChooser: Type.Optional(Type.Union([Type.Object({ multiple: Type.Boolean() }), Type.Null()])),
})

export const AgentStepRecordSchema = Type.Object({
  tool: Type.String(),
  summary: Type.Optional(Type.String()),
  succeeded: Type.Optional(Type.Boolean()),
  step: Type.Optional(Type.Integer()),
})

export const AgentProgressItemSchema = Type.Object({
  step: Type.String(),
  status: Type.Union([Type.Literal('done'), Type.Literal('in_progress'), Type.Literal('todo')]),
})

// Text the agent itself entered. Kept for the whole task, unlike the rolling
// step log, so the planner can never lose track of content it already wrote.
export const AgentContentEntrySchema = Type.Object({
  step: Type.Integer(),
  tool: Type.String(),
  target: Type.Optional(Type.String()),
  page: Type.String(),
  chars: Type.Integer(),
  head: Type.String(),
  tail: Type.String(),
  status: Type.Union([Type.Literal('verified'), Type.Literal('unverifiable'), Type.Literal('failed')]),
})

export const AgentSessionTaskSchema = Type.Object({
  goal: Type.String(),
  status: Type.String(),
  outcome: Type.String(),
  milestones: Type.Array(Type.String()),
  finalUrl: Type.String(),
})

export const AgentFailureRecordSchema = Type.Object({
  tool: Type.String(),
  reason: Type.Optional(Type.String()),
  code: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

// The planner's entire recollection. Deliberately not a conversation
// transcript: a bounded, structured summary keeps the prompt small and stops
// older page content from accumulating in context.
export const AgentWorkingMemorySchema = Type.Object({
  goal: Type.Optional(Type.String()),
  completed_steps: Type.Optional(Type.Array(AgentStepRecordSchema)),
  pending_steps: Type.Optional(Type.Array(Type.String())),
  failures: Type.Optional(Type.Array(AgentFailureRecordSchema)),
  retries: Type.Optional(Type.Integer()),
  current_page: Type.Optional(Type.String()),
  extracted_knowledge: Type.Optional(Type.Array(Type.String())),
  invalid_elements: Type.Optional(Type.Array(Type.String())),
  last_thought: Type.Optional(Type.String()),
  step_number: Type.Optional(Type.Integer()),
  plan_progress: Type.Optional(Type.Array(AgentProgressItemSchema)),
  milestones: Type.Optional(Type.Array(Type.String())),
  content_entered: Type.Optional(Type.Array(AgentContentEntrySchema)),
  session_history: Type.Optional(Type.Array(AgentSessionTaskSchema)),
})

export const AgentPlanRequestSchema = Type.Object({
  goal: Type.String(),
  working_memory: Type.Optional(AgentWorkingMemorySchema),
  page_state: Type.Optional(AgentPageStateSchema),
})

// A single validated action. `arguments` is already schema-checked.
export const AgentToolCallSchema = Type.Object({
  tool: Type.String(),
  arguments: Type.Record(Type.String(), Type.Unknown()),
  requires_approval: Type.Boolean(),
})

export const AgentPlanResponseSchema = Type.Object({
  tool_calls: Type.Array(AgentToolCallSchema, { minItems: 1 }),
  tool_call: AgentToolCallSchema,
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  needs_user_confirmation: Type.Boolean(),
  reason: Type.String(),
  thought: Type.Optional(Type.String()),
  progress: Type.Optional(Type.Array(AgentProgressItemSchema)),
  model: Type.String(),
  planner_mode: Type.Literal('llm'),
})

export type AgentSemanticElement = Static<typeof AgentSemanticElementSchema>
export type AgentSemanticDialog = Static<typeof AgentSemanticDialogSchema>
export type AgentValidationIssue = Static<typeof AgentValidationIssueSchema>
export type AgentPageState = Static<typeof AgentPageStateSchema>
export type AgentStepRecord = Static<typeof AgentStepRecordSchema>
export type AgentFailureRecord = Static<typeof AgentFailureRecordSchema>
export type AgentProgressItem = Static<typeof AgentProgressItemSchema>
export type AgentWorkingMemory = Static<typeof AgentWorkingMemorySchema>
export type AgentPlanRequest = Static<typeof AgentPlanRequestSchema>
export type AgentToolCall = Static<typeof AgentToolCallSchema>
export type AgentPlanResponse = Static<typeof AgentPlanResponseSchema>
