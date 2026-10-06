import type {
  AgentAbortReason,
  AgentPlanResponse,
  AgentTaskResult,
  AgentToolCall,
} from '../types/agentTypes'
import type { PageStateSnapshot } from '../types/browserRuntimeTypes'
import { approvalFor, type ApprovalHandler } from './agentApprovalPolicy'
import { AgentWorkingMemory, CONTENT_MIN_CHARS, documentKey } from './agentWorkingMemory'
import { AgentPlanError, requestPlan } from './agentApiClient'
import { extractPageState, invokeRuntime, isBrowserRuntimeAvailable, setAgentInputLock, setAgentOverlay } from './browserRuntime'
import { isTerminalTool, resolveToolCall } from './agentToolRegistry'
import { agentBrowserMemory } from './agentBrowserMemory'
import { agentSessionMemory } from './agentSessionMemory'
import { describeAgentActivity } from './agentActivity'

/**
 * The agent loop.
 *
 * Runs entirely in the renderer: every browser action goes out over
 * `invokeRuntime` to the CDP-native Browser Runtime (native input, verified
 * before/after) and every plan comes from the backend planner.
 *
 * Security scanning has been removed from the agent execution path to
 * eliminate the latency overhead of the DL classifier on every iteration.
 * Users can still manually scan any page via the toolbar "Scan Page" button
 * which uses its own independent endpoint (POST /security/check-webpage).
 *
 * There is no main-process agent process to hand off to — this class *is*
 * the orchestrator.
 */

export type AgentTaskEvents = {
  onPlanning?: () => void
  onPlan?: (summary: string) => void
  onAction?: (toolCall: AgentToolCall) => void
  onStep?: (step: number, toolCall: AgentToolCall, activity: { summary: string; detail: string }) => void
  onStatus?: (message: string) => void
}

export type AgentTaskOptions = {
  taskId: string
  goal: string
  targetId: number
  maxSteps?: number
  signal?: AbortSignal
  events?: AgentTaskEvents
  visualFeedback?: boolean
  onApprovalRequest?: ApprovalHandler
  onOpenTab?: (url?: string) => Promise<number | null>
}

/** One planning round trip may queue several actions; each still costs one step. */
const DEFAULT_MAX_STEPS = 150

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Identifies *what was acted on*, not just what happened to it. Working
 * memory is the planner's only continuity between steps — a summary that
 * says "The page changed" without naming the element gives it no way to tell
 * "I already did this one" from "I haven't tried this one yet", which is
 * exactly the gap that lets it reclick the same element over and over.
 */
function describeToolCall(toolCall: AgentToolCall, pageState?: PageStateSnapshot): string {
  const args = toolCall.arguments ?? {}
  const target = typeof args.target === 'string' ? args.target : null
  const extra = ['value', 'text', 'key', 'url', 'note', 'summary']
    .map((key) => (typeof args[key] === 'string' ? String(args[key]) : null))
    .find((value): value is string => Boolean(value))

  const parts: string[] = [toolCall.tool]
  if (target) {
    // Element ids are re-issued on every extraction, so "e12" means nothing a
    // few steps later. The role and name are what identify the control.
    const element = pageState?.elements.find((candidate) => candidate.id === target)
    parts.push(element ? `${target} [${element.role}] "${(element.name || '').slice(0, 60)}"` : target)
  }
  if (extra) {
    const flat = extra.replace(/\s+/g, ' ')
    parts.push(flat.length > 60 ? `"${flat.slice(0, 60)}…" (${extra.length} chars)` : `"${flat}"`)
  }
  return parts.join(' ')
}

/** Text a content-entering action would put on the page, if any. */
function enteredText(toolCall: AgentToolCall): string | null {
  const args = toolCall.arguments ?? {}
  if (toolCall.tool === 'type' && typeof args.text === 'string') return args.text
  if (toolCall.tool === 'fill' && typeof args.value === 'string') return args.value
  return null
}

/** Outcome of running one queued action. `null` means "keep going in this queue". */
type ActionOutcome = AgentTaskResult | null

export class AgentTask {
  readonly taskId: string
  readonly goal: string
  private targetId: number
  private readonly maxSteps: number
  private readonly signal?: AbortSignal
  private readonly events: AgentTaskEvents
  private readonly visualFeedback: boolean
  private readonly onApprovalRequest?: ApprovalHandler
  private readonly onOpenTab?: (url?: string) => Promise<number | null>

  private readonly memory: AgentWorkingMemory
  private stepCount = 0
  private currentPlanSummary = ''
  private currentActionDetail = ''
  /**
   * A malformed plan (missing argument, invented tool, bad JSON) is the LLM
   * mis-stepping, not the task failing — the fix is to tell it what went
   * wrong and let it try again, not end the run. This counts *consecutive*
   * planning failures specifically, separately from `stepCount`, because a
   * failed plan never reaches an action and so never advances the step
   * count — without its own cap this could otherwise retry forever.
   */
  private plannerFailureStreak = 0
  private static readonly MAX_PLANNER_FAILURES = 12
  private readonly actionHistory: string[] = []
  private static readonly STAGNATION_WINDOW = 9
  private static readonly STAGNATION_THRESHOLD = 3
  /**
   * The exact-page signature above never repeats on a page that keeps
   * changing (an editor, a feed), so it misses a planner that keeps choosing
   * the same control on it. This second window matches on the control's role
   * and name instead of the whole page.
   */
  private readonly intentHistory: string[] = []
  private static readonly INTENT_WINDOW = 10
  private static readonly INTENT_THRESHOLD = 4
  /**
   * Consecutive plans whose action a guard refused (loop, duplicate content,
   * dead element). A refused action never executes, so it never advances
   * `stepCount` — without this cap a planner that keeps proposing the same
   * refused action would spin forever.
   */
  private guardRejectionStreak = 0
  private static readonly MAX_GUARD_REJECTIONS = 6
  private sessionRecorded = false

  /** Builds an action signature to detect repetitive non-progressing actions. */
  private buildActionSignature(toolCall: AgentToolCall, pageState: PageStateSnapshot): string {
    const args = toolCall.arguments ?? {}
    return JSON.stringify([pageState.url, toolCall.tool, args, pageState.elements])
  }

  private buildIntentSignature(toolCall: AgentToolCall, pageState: PageStateSnapshot): string {
    const { target, ...rest } = toolCall.arguments ?? {}
    const element = typeof target === 'string' ? pageState.elements.find((candidate) => candidate.id === target) : undefined
    const targetKey = element ? `${element.role}:${element.name}` : (typeof target === 'string' ? target : '')
    return JSON.stringify([documentKey(pageState.url), toolCall.tool, targetKey, rest])
  }

  private static pushWindow(history: string[], signature: string, windowSize: number): number {
    history.push(signature)
    if (history.length > windowSize) history.shift()
    return history.filter((sig) => sig === signature).length
  }

  /**
   * Tracks actions in rolling windows. Returns true if the same action
   * repeats without forward progress.
   */
  private detectStagnation(toolCall: AgentToolCall, pageState: PageStateSnapshot): boolean {
    // Repeated sampling and wheel events are normal for virtualized content.
    if (['evaluate', 'element_bounds', 'dispatch_mouse_event', 'extract_virtual_table', 'scroll'].includes(toolCall.tool)) return false
    const exact = AgentTask.pushWindow(this.actionHistory, this.buildActionSignature(toolCall, pageState), AgentTask.STAGNATION_WINDOW)
    const intent = AgentTask.pushWindow(this.intentHistory, this.buildIntentSignature(toolCall, pageState), AgentTask.INTENT_WINDOW)
    return exact >= AgentTask.STAGNATION_THRESHOLD || intent >= AgentTask.INTENT_THRESHOLD
  }

  /**
   * Counts a refused action. Returns a final result once the planner has
   * proposed only refused actions too many times in a row.
   */
  private rejectAction(): ActionOutcome {
    this.guardRejectionStreak += 1
    this.memory.incrementRetries()
    if (this.guardRejectionStreak >= AgentTask.MAX_GUARD_REJECTIONS) {
      return this.finalResult(
        'failed',
        'Stopped: the agent kept proposing actions it had already done or that could not work. ' +
          'Progress so far is listed in the steps above.',
        'action_failed',
      )
    }
    return null
  }

  constructor(options: AgentTaskOptions) {
    this.taskId = options.taskId
    this.goal = options.goal.trim()
    this.targetId = options.targetId
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    this.signal = options.signal
    this.events = options.events ?? {}
    this.visualFeedback = options.visualFeedback !== false
    this.onApprovalRequest = options.onApprovalRequest
    this.onOpenTab = options.onOpenTab
    this.memory = new AgentWorkingMemory(this.goal, agentSessionMemory.history())
  }

  async run(): Promise<AgentTaskResult> {
    if (!isBrowserRuntimeAvailable()) {
      return this.finalResult('failed', 'Browser runtime is not available in this environment.')
    }

    // The user's own mouse and keyboard are locked out of the tab for the
    // whole task, so a stray click cannot undo what the agent just did.
    await setAgentInputLock(this.targetId, true)
    if (this.visualFeedback) {
      await setAgentOverlay(this.targetId, true).catch(() => undefined)
    }

    try {
      while (this.stepCount < this.maxSteps) {
        if (this.signal?.aborted) {
          return this.finalResult('failed', 'Task was stopped by the user.', 'cancelled')
        }

        this.events.onPlanning?.()
        this.events.onStatus?.('Reviewing the page and planning the next action…')

        const stateResult = await extractPageState(this.targetId)
        if (!stateResult.ok) {
          const errorMsg = 'error' in stateResult && stateResult.error ? stateResult.error.message : 'Unknown error'
          return this.finalResult('failed', `Could not read the page: ${errorMsg}`, 'action_failed')
        }
        const pageState = stateResult.data
        this.memory.setCurrentPage(pageState.url)

        let plan: AgentPlanResponse
        try {
          plan = await requestPlan(this.goal, this.memory, pageState, this.signal)
        } catch (error) {
          if (isAbortError(error)) {
            return this.finalResult('failed', 'Task was stopped by the user.', 'cancelled')
          }
          if (error instanceof AgentPlanError) {
            if (error.kind === 'unavailable') {
              return this.finalResult('failed', error.message, 'planner_failed')
            }

            this.plannerFailureStreak += 1
            this.memory.recordFailure('plan', error.message, error.kind)
            if (this.plannerFailureStreak >= AgentTask.MAX_PLANNER_FAILURES) {
              return this.finalResult('failed', `The planner kept failing: ${error.message}`, 'planner_failed')
            }

            const backoffMs = Math.min(500 * Math.pow(1.5, this.plannerFailureStreak - 1), 4000)
            this.events.onStatus?.(`Planner error, retrying: ${error.message}`)
            await new Promise((resolve) => setTimeout(resolve, backoffMs))
            continue
          }
          throw error
        }

        if (this.signal?.aborted) return this.finalResult('failed', 'Task was stopped by the user.', 'cancelled')
        this.plannerFailureStreak = 0
        // The public action summary is separate from the model's internal reasoning.
        this.currentPlanSummary = plan.reason?.trim().slice(0, 500) || plan.tool_calls.map(describeAgentActivity).join(' · ')
        this.events.onPlan?.(this.currentPlanSummary)
        if (plan.thought) {
          this.memory.setLastThought(plan.thought)
        }
        this.memory.setPlanProgress(plan.progress)

        const outcome = await this.executeQueue(plan, pageState)
        if (outcome) return outcome
      }

      return this.finalResult('failed', `Stopped after reaching the ${this.maxSteps}-step limit.`, 'step_limit')
    } finally {
      await setAgentInputLock(this.targetId, false)
      if (this.visualFeedback) {
        await setAgentOverlay(this.targetId, false).catch(() => undefined)
      }
    }
  }

  /** Runs every queued action in order. Returns a final result, or null to keep planning. */
  private async executeQueue(
    plan: AgentPlanResponse,
    pageState: PageStateSnapshot,
  ): Promise<ActionOutcome> {
    for (const toolCall of plan.tool_calls) {
      // Snapshot each action's context before execution. Queued actions share
      // the public plan, but retain their own human-readable target labels.
      const target = pageState.elements.find(element => element.id === toolCall.arguments?.target)
      const targetName = target?.name?.trim()
      this.currentActionDetail = targetName
        ? `${describeAgentActivity(toolCall)} · ${targetName.slice(0, 160)}`
        : describeAgentActivity(toolCall)
      if (this.stepCount >= this.maxSteps) return null // outer loop reports the limit
      if (this.signal?.aborted) {
        return this.finalResult('failed', 'Task was stopped by the user.', 'cancelled')
      }

      const targetIdArg = typeof toolCall.arguments?.target === 'string' ? toolCall.arguments.target : ''

      // Duplicate-content guard: text this task already delivered is never
      // entered again. Canvas editors (Google Docs) do not expose their body
      // to the page state, so "I can't see my text" must not become "type it
      // again" — that is how a document ends up with the same letter 5 times.
      // Only `type` is guarded: it appends at the cursor, so a repeat stacks a
      // second copy. `fill` replaces its field, so repeating it cannot.
      const text = enteredText(toolCall)
      if (text !== null && toolCall.tool === 'type') {
        const duplicate = this.memory.findDuplicateContent(text, pageState.url)
        if (duplicate) {
          const { entry, samePage } = duplicate
          this.memory.recordFailure(
            toolCall.tool,
            `DUPLICATE CONTENT REFUSED: this text (or a reworded version of it) was already entered at step ${entry.step}` +
              `${samePage ? ' on this same page' : ` on ${entry.page}`} (${entry.chars} chars, starting "${entry.head.slice(0, 60)}"). ` +
              'It is already there — the editor may simply not show its body in the page state. ' +
              'Do NOT type or rewrite it again; continue with whatever the goal still needs.',
            'DUPLICATE_CONTENT',
          )
          // The checklist is deliberately left to the planner. Marking the
          // current sub-goal done here would turn one wrong refusal into a
          // skipped sub-goal (e.g. "download" before anything was written).
          this.events.onStatus?.('That text was already entered earlier — skipping the re-type and replanning…')
          return this.rejectAction()
        }
      }

      // Loop/Stagnation Detector: prevent repeating identical actions
      if (!isTerminalTool(toolCall) && this.detectStagnation(toolCall, pageState)) {
        const desc = describeToolCall(toolCall, pageState)
        if (targetIdArg) {
          this.memory.recordInvalidElement(targetIdArg)
        }
        this.memory.recordFailure(
          toolCall.tool,
          `Loop / stagnation detected: '${desc}' keeps being repeated without forward progress. ` +
            'Check MILESTONES and PLAN PROGRESS: if this sub-goal is already achieved, move to the next one; otherwise try a different control or strategy.',
          'LOOP_DETECTED',
        )
        this.events.onStatus?.(`Loop detected on '${toolCall.tool}'. Replanning alternative action...`)
        return this.rejectAction()
      }

      // Pre-execution guard: fast microsecond check against blacklisted or disabled elements
      if (targetIdArg) {
        if (this.memory.isElementInvalid(targetIdArg)) {
          this.memory.recordFailure(
            toolCall.tool,
            `Target element '${targetIdArg}' was previously non-responsive or failed. Skipping dead element to replan.`,
            'ELEMENT_NOT_INTERACTABLE',
          )
          this.events.onStatus?.(`Skipping dead element '${targetIdArg}'. Replanning...`)
          return this.rejectAction()
        }

        const knownElement = pageState.elements.find((el) => el.id === targetIdArg)
        if (knownElement?.disabled && (toolCall.tool === 'click' || toolCall.tool === 'fill')) {
          this.memory.recordInvalidElement(targetIdArg)
          this.memory.recordFailure(
            toolCall.tool,
            `Element '${targetIdArg}' ("${knownElement.name || knownElement.role}") is disabled and cannot be interacted with.`,
            'ELEMENT_NOT_INTERACTABLE',
          )
          this.events.onStatus?.(`Element '${targetIdArg}' is disabled. Replanning...`)
          return this.rejectAction()
        }
      }

      const approvalRequest = approvalFor(toolCall, pageState, {
        lowConfidence: plan.needs_user_confirmation,
        confidence: plan.confidence,
      })

      if (approvalRequest) {
        if (!this.onApprovalRequest) {
          this.memory.recordFailure(toolCall.tool, 'This action needs approval, but nothing can ask for it here.')
          return this.rejectAction()
        }

        const granted = await this.onApprovalRequest(approvalRequest)
        if (this.signal?.aborted) {
          return this.finalResult('failed', 'Task was stopped by the user.', 'cancelled')
        }
        if (!granted) {
          return this.finalResult('failed', `You declined: ${approvalRequest.summary}`, 'declined')
        }
      }

      this.events.onAction?.(toolCall)
      this.events.onStatus?.(describeAgentActivity(toolCall))

      if (isTerminalTool(toolCall)) {
        const summary = typeof toolCall.arguments?.summary === 'string' && toolCall.arguments.summary
          ? toolCall.arguments.summary
          : 'Goal achieved.'
        this.recordStep(toolCall)
        return this.finalResult('completed', summary)
      }

      if (toolCall.tool === 'open_tab') {
        const outcome = await this.runOpenTab(toolCall)
        if (outcome) return outcome
        return null // target changed — the old page state is no longer valid
      }

      if (toolCall.tool === 'extract') {
        const note = typeof toolCall.arguments?.note === 'string' && toolCall.arguments.note
          ? toolCall.arguments.note
          : 'Recorded a finding.'
        this.recordStep(toolCall)
        this.memory.recordFinding(note)
        this.memory.recordStep('extract', note, true)
        continue
      }

      // Graceful handling of blocked side pages prior to runtime dispatch:
      if (toolCall.tool === 'navigate') {
        const targetUrl = typeof toolCall.arguments?.url === 'string' ? toolCall.arguments.url : ''
        if (targetUrl && agentBrowserMemory.isBlocked(targetUrl)) {
          this.recordStep(toolCall)
          this.memory.recordFailure(
            'navigate',
            `Navigation to '${targetUrl}' was prevented because the origin is blocked/untrusted. Find an alternative route or proceed with current page content.`,
            'NAVIGATION_BLOCKED',
          )
          this.memory.incrementRetries()
          this.events.onStatus?.(`Navigation to blocked origin '${targetUrl}' was prevented. Replanning alternative path...`)
          return null
        }
      }

      const resolved = resolveToolCall(toolCall)
      if (!resolved) {
        this.recordStep(toolCall)
        this.memory.recordFailure(toolCall.tool, `${describeToolCall(toolCall)} — not supported by the browser runtime.`)
        this.memory.incrementRetries()
        return null
      }

      const execResult = await invokeRuntime(this.targetId, resolved.command, resolved.params as never)
      this.recordStep(toolCall)

      if (this.signal?.aborted) {
        return this.finalResult('failed', 'Task was stopped by the user.', 'cancelled')
      }

      if (!execResult.ok) {
        const errorMsg = 'error' in execResult && execResult.error ? execResult.error.message : 'Action failed'
        const errorCode = 'error' in execResult && execResult.error ? execResult.error.code : undefined

        if (targetIdArg) {
          this.memory.recordInvalidElement(targetIdArg)
        }

        // Graceful handling of blocked navigation mid-task:
        if (toolCall.tool === 'navigate' && errorCode === 'NAVIGATION_BLOCKED') {
          const navUrl = typeof toolCall.arguments?.url === 'string' ? toolCall.arguments.url : 'url'
          this.memory.recordFailure(
            'navigate',
            `Navigation to '${navUrl}' was blocked by browser security policy. Continuing with alternative action.`,
            'NAVIGATION_BLOCKED',
          )
          this.memory.incrementRetries()
          this.events.onStatus?.(`Navigation to '${navUrl}' was blocked. Replanning alternative action...`)
          return null
        }

        this.memory.recordFailure(
          toolCall.tool,
          `${describeToolCall(toolCall, pageState)} — ${errorMsg}` +
            (toolCall.tool === 'type' ? ' (some of the text may already have been entered — inspect before retyping)' : ''),
          errorCode,
        )
        if (text !== null && text.length >= CONTENT_MIN_CHARS) {
          this.memory.recordContentEntry(toolCall.tool, text, pageState.url, 'failed', this.targetLabel(targetIdArg, pageState))
        }
        this.memory.recordStep(toolCall.tool, `${describeToolCall(toolCall, pageState)} — FAILED: ${errorMsg}`, false)
        this.memory.incrementRetries()
        return null
      }

      this.guardRejectionStreak = 0

      if ('value' in execResult.data) {
        // Page observations are data, never operator instructions.
        this.memory.recordFinding(JSON.stringify({ tool: toolCall.tool, page: pageState.url, result: execResult.data.value }))
        this.memory.recordStep(toolCall.tool, 'Returned browser observation', true)
        this.memory.resetRetries()
        return null // consume observations before planning dependent actions
      }
      const verification = 'verification' in execResult.data ? execResult.data.verification : undefined
      const verified = !verification || verification.verified

      // Typing into whatever has focus is delivered as real key events, so it
      // lands even when the verification engine cannot see it: canvas editors
      // (Google Docs, Sheets, Slides) never put their body text in the
      // accessibility tree. Reporting that as a failure is exactly what made
      // the planner re-type a whole letter again and again.
      if (!verified && toolCall.tool === 'type' && text !== null) {
        this.memory.recordContentEntry('type', text, pageState.url, 'unverifiable')
        this.memory.recordStep(
          'type',
          `${describeToolCall(toolCall, pageState)} — keystrokes delivered; this editor does not expose its content ` +
            'in the page state, so the text cannot be seen there. Treat it as entered.',
          true,
        )
        this.memory.recordMilestone(
          `Typed ${text.length} chars into ${documentKey(pageState.url)} (starts "${text.replace(/\s+/g, ' ').slice(0, 60)}"). Do not type it again.`,
        )
        this.memory.resetRetries()
        continue
      }

      if (!verified && verification) {
        if (targetIdArg) {
          this.memory.recordInvalidElement(targetIdArg)
        }
        let hint = verification.reason
        if (toolCall.tool === 'press_key' && toolCall.arguments?.key === 'Enter') {
          hint += ' (If submitting a filter or setting, find and click the nearby apply/submit button instead)'
        }
        this.memory.recordFailure(toolCall.tool, `${describeToolCall(toolCall, pageState)} — ${hint}`, 'NOT_VERIFIED')
        this.memory.recordStep(toolCall.tool, `${describeToolCall(toolCall, pageState)} — no visible effect`, false)
        this.memory.incrementRetries()
        return null
      }

      this.memory.recordStep(
        toolCall.tool,
        `${describeToolCall(toolCall, pageState)} — ${verification?.reason ?? 'completed'}`,
        true,
      )
      this.memory.resetRetries()
      this.recordMilestoneFor(toolCall, pageState, text, verification?.urlChanged === true, verification?.reason)

      if (toolCall.tool === 'navigate') {
        return null // element ids from the old page are gone
      }
    }

    return null
  }

  private targetLabel(targetId: string, pageState: PageStateSnapshot): string | undefined {
    if (!targetId) return undefined
    const element = pageState.elements.find((candidate) => candidate.id === targetId)
    return element ? `[${element.role}] "${(element.name || '').slice(0, 60)}"` : targetId
  }

  /** Writes the durable progress facts that must outlive the rolling step log. */
  private recordMilestoneFor(
    toolCall: AgentToolCall,
    pageState: PageStateSnapshot,
    text: string | null,
    urlChanged: boolean,
    reason?: string,
  ): void {
    const args = toolCall.arguments ?? {}
    const targetId = typeof args.target === 'string' ? args.target : ''

    if (text !== null && text.length >= CONTENT_MIN_CHARS) {
      const label = this.targetLabel(targetId, pageState)
      this.memory.recordContentEntry(toolCall.tool, text, pageState.url, 'verified', label)
      this.memory.recordMilestone(
        `Entered ${text.length} chars${label ? ` into ${label}` : ''} on ${documentKey(pageState.url)} ` +
          `(starts "${text.replace(/\s+/g, ' ').slice(0, 60)}"). Do not enter it again.`,
      )
      return
    }

    if (toolCall.tool === 'fill' && text !== null) {
      // The runtime's reason carries outcomes the page state cannot show, such
      // as an address that became a recipient chip and left its field empty.
      this.memory.recordMilestone(
        `Set ${this.targetLabel(targetId, pageState) ?? 'a field'} to "${text.slice(0, 60)}"${reason ? ` — ${reason}` : ''}`,
      )
      return
    }

    if (toolCall.tool === 'navigate') {
      this.memory.recordMilestone(`Opened ${typeof args.url === 'string' ? args.url : 'a page'}`)
      return
    }

    if (toolCall.tool === 'click' && urlChanged) {
      this.memory.recordMilestone(`Clicked ${this.targetLabel(targetId, pageState) ?? 'an element'} on ${documentKey(pageState.url)} — page changed to a new URL`)
    }
  }

  private async runOpenTab(toolCall: AgentToolCall): Promise<AgentTaskResult | null> {
    const url = typeof toolCall.arguments?.url === 'string' ? toolCall.arguments.url : undefined

    if (url && agentBrowserMemory.isBlocked(url)) {
      this.recordStep(toolCall)
      this.memory.recordFailure(
        'open_tab',
        `Opening tab to '${url}' was prevented because this origin is blocked/untrusted.`,
        'NAVIGATION_BLOCKED',
      )
      this.memory.incrementRetries()
      this.events.onStatus?.(`Blocked tab open was prevented for '${url}'. Replanning...`)
      return null
    }

    if (!this.onOpenTab) {
      this.recordStep(toolCall)
      this.memory.recordFailure('open_tab', 'Opening new tabs is not supported in this context.')
      this.memory.incrementRetries()
      return null
    }

    let newTargetId: number | null
    try {
      newTargetId = await this.onOpenTab(url)
    } catch (error) {
      this.recordStep(toolCall)
      this.memory.recordFailure('open_tab', error instanceof Error ? error.message : 'Failed to open a new tab.')
      this.memory.incrementRetries()
      return null
    }

    this.recordStep(toolCall)

    if (newTargetId === null) {
      this.memory.recordFailure('open_tab', 'Opening the tab was cancelled or timed out.')
      this.memory.incrementRetries()
      return null
    }

    // The lock follows the agent to the tab it now drives.
    await setAgentInputLock(this.targetId, false)
    this.targetId = newTargetId
    await setAgentInputLock(this.targetId, true)
    this.memory.recordStep('open_tab', `Opened a new tab${url ? ` at ${url}` : ''}.`, true)
    this.memory.recordMilestone(`Opened a new tab${url ? ` at ${url}` : ''} and switched to it`)
    this.memory.resetRetries()
    this.guardRejectionStreak = 0
    return null
  }

  private recordStep(toolCall: AgentToolCall): void {
    this.stepCount += 1
    this.memory.beginStep()
    this.events.onStep?.(this.stepCount, toolCall, {
      summary: this.currentPlanSummary || describeAgentActivity(toolCall),
      detail: this.currentActionDetail,
    })
  }

  private finalResult(
    status: AgentTaskResult['status'],
    message: string,
    reason?: AgentAbortReason,
  ): AgentTaskResult {
    // Every exit path funnels through here, so this is where the task's own
    // record is handed to session memory for any follow-up goal.
    if (!this.sessionRecorded) {
      this.sessionRecorded = true
      agentSessionMemory.record({
        goal: this.goal,
        status: reason ? `${status} (${reason})` : status,
        outcome: message,
        milestones: [...this.memory.milestoneLog],
        finalUrl: this.memory.page,
      })
    }
    return { taskId: this.taskId, status, message, steps: this.stepCount, reason }
  }
}
