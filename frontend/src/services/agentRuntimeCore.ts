import type {
  AgentAbortReason,
  AgentPlanResponse,
  AgentTaskBrief,
  AgentTaskResult,
  AgentToolCall,
  AgentVerification,
} from '../types/agentTypes'
import type { PageStateSnapshot } from '../types/browserRuntimeTypes'
import { approvalFor, type ApprovalHandler } from './agentApprovalPolicy'
import { AgentWorkingMemory, CONTENT_MIN_CHARS, documentKey } from './agentWorkingMemory'
import { AgentPlanError, requestAnalysis, requestPlan, requestVerification } from './agentApiClient'
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
 * Users can still manually scan any page via the toolbar Orbit Scan button
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
  /** The up-front analysis is ready: requirements, plan, drafted content. */
  onAnalysis?: (brief: AgentTaskBrief) => void
  /**
   * A finish claim was checked. `rejected`: sent back to work on what is
   * missing; `accepted`: verified; `unconfirmed`: finished without confirmation.
   */
  onVerification?: (verification: AgentVerification, outcome: 'accepted' | 'rejected' | 'unconfirmed') => void
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
  /**
   * Hands the tab to the user (sign-in, CAPTCHA, a choice) and resolves with
   * their reply, or null if they chose to stop. Omitted: ask_user is refused.
   */
  onUserInput?: (request: { question: string }) => Promise<string | null>
  /**
   * Returns (and forgets) the tabs that `openerTargetId` opened since the last
   * call — a link with target=_blank, window.open. The loop follows the newest.
   */
  takeOpenedTabs?: (openerTargetId: number) => number[]
}

/** One planning round trip may queue several actions; each still costs one step. */
const DEFAULT_MAX_STEPS = 150

/**
 * How many times the self-check may send a finish claim back. After that the
 * task ends anyway, reported as not verified, rather than looping on a
 * requirement the reviewer cannot see evidence for.
 */
const MAX_VERIFICATION_REJECTIONS = 3

/** The text `readText` returned, or '' when it is unavailable. */
function observedText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return typeof record.text === 'string' ? record.text : ''
}

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
  private readonly onUserInput?: (request: { question: string }) => Promise<string | null>
  private readonly takeOpenedTabs?: (openerTargetId: number) => number[]

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
  private analysed = false
  private verificationRejections = 0
  /** Popups already closed (or tried) once, so one that keeps returning cannot loop. */
  private readonly dismissedPopups = new Set<string>()
  private static readonly MAX_AUTO_DISMISS_PER_PASS = 3

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
    if (['evaluate', 'element_bounds', 'dispatch_mouse_event', 'extract_virtual_table', 'scroll', 'read_text', 'hover'].includes(toolCall.tool)) return false
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
    this.onUserInput = options.onUserInput
    this.takeOpenedTabs = options.takeOpenedTabs
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
        const pageState = await this.dismissPopups(stateResult.data)
        this.memory.setCurrentPage(pageState.url)

        if (!this.analysed) {
          const stopped = await this.analyse(pageState)
          if (stopped) return stopped
        }

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

            const rateLimited = error.kind === 'rate_limited'
            const backoffMs = rateLimited
              ? Math.min(5000 * Math.pow(2, this.plannerFailureStreak - 1), 30_000)
              : Math.min(500 * Math.pow(1.5, this.plannerFailureStreak - 1), 4000)
            this.events.onStatus?.(
              rateLimited
                ? `The AI provider is rate-limiting requests — waiting ${Math.round(backoffMs / 1000)}s before retrying…`
                : `Planner error, retrying: ${error.message}`,
            )
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
        return this.finish(toolCall, pageState)
      }

      if (toolCall.tool === 'open_tab') {
        const outcome = await this.runOpenTab(toolCall)
        if (outcome) return outcome
        return null // target changed — the old page state is no longer valid
      }

      if (toolCall.tool === 'ask_user') {
        return this.runAskUser(toolCall)
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

      // A click (or Enter, or a script) that opened a new tab: work there now.
      if (await this.followOpenedTab()) {
        this.memory.recordStep(toolCall.tool, `${describeToolCall(toolCall, pageState)} — opened a new tab`, true)
        return null
      }

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

      if (toolCall.tool === 'navigate' || toolCall.tool === 'go_back') {
        return null // element ids from the old page are gone
      }
    }

    return null
  }

  /**
   * Closes onboarding tips and offers whose close button is unmistakably
   * harmless ("Got it", "Dismiss", "No thanks" — AUTO_CLOSE_LABEL in the State
   * Builder) before the planner sees the page. Each is a real click through
   * the runtime, shown as a step, and still subject to the approval policy.
   * Anything else ("Close", side panels) is left to the planner, which sees
   * it under POPUPS OPEN. Returns the page state after closing.
   */
  private async dismissPopups(pageState: PageStateSnapshot): Promise<PageStateSnapshot> {
    let state = pageState
    for (let pass = 0; pass < AgentTask.MAX_AUTO_DISMISS_PER_PASS; pass++) {
      const candidate = (state.popups ?? [])
        .flatMap((popup) => popup.closeButtons.filter((button) => button.auto).map((button) => ({ popup, button })))
        .map((entry) => ({ ...entry, key: `${documentKey(state.url)}|${entry.popup.name}|${entry.button.name}` }))
        .find((entry) => !this.dismissedPopups.has(entry.key))
      if (!candidate || this.signal?.aborted) return state
      this.dismissedPopups.add(candidate.key)

      const toolCall: AgentToolCall = { tool: 'click', arguments: { target: candidate.button.id } }
      if (approvalFor(toolCall, state, {})) continue // never auto-click anything the policy would question

      const label = candidate.popup.name ? `"${candidate.popup.name.slice(0, 60)}"` : 'a popup'
      this.currentPlanSummary = 'Closing a popup that is in the way'
      this.currentActionDetail = `${candidate.button.name} · ${label}`
      this.events.onStatus?.(`Closing ${label} (${candidate.button.name})…`)
      const clicked = await invokeRuntime(this.targetId, 'click', { elementId: candidate.button.id })
      this.recordStep(toolCall)
      if (clicked.ok) {
        this.memory.recordMilestone(`Closed ${label} with "${candidate.button.name}" so it does not get in the way`)
        this.memory.recordStep('click', `Closed ${label} with "${candidate.button.name}"`, true)
      }

      const fresh = await extractPageState(this.targetId)
      if (!fresh.ok) return state
      state = fresh.data
    }
    return state
  }

  /**
   * Switches the task to the newest tab its own tab opened since the last
   * check. Tabs the user opened themselves are never followed: only popups
   * whose opener is the tab the agent is driving are reported.
   */
  private async followOpenedTab(): Promise<boolean> {
    const opened = this.takeOpenedTabs?.(this.targetId) ?? []
    for (const candidate of [...opened].reverse()) {
      if (!(await this.waitForTarget(candidate))) continue
      await setAgentInputLock(this.targetId, false)
      if (this.visualFeedback) await setAgentOverlay(this.targetId, false).catch(() => undefined)
      this.targetId = candidate
      await setAgentInputLock(this.targetId, true)
      if (this.visualFeedback) await setAgentOverlay(this.targetId, true).catch(() => undefined)
      const described = await invokeRuntime(candidate, 'describeTarget', {})
      const url = described.ok ? described.data.url : 'a new tab'
      this.memory.recordMilestone(`The page opened a new tab (${url}); now working in that tab`)
      this.events.onStatus?.('A new tab opened — continuing there…')
      this.memory.resetRetries()
      return true
    }
    return false
  }

  /** A popup's runtime session attaches a moment after the tab appears. */
  private async waitForTarget(targetId: number): Promise<boolean> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const described = await invokeRuntime(targetId, 'describeTarget', {})
      if (described.ok && described.data.attached) return true
      if (this.signal?.aborted) return false
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return false
  }

  /**
   * Hands the tab to the user: their input is unlocked, the question is shown,
   * and the task resumes with their reply. The reply is the user's own words,
   * so it is recorded as a milestone the planner and the self-check both see.
   */
  private async runAskUser(toolCall: AgentToolCall): Promise<ActionOutcome> {
    const question = typeof toolCall.arguments?.question === 'string' && toolCall.arguments.question.trim()
      ? toolCall.arguments.question.trim().slice(0, 500)
      : 'Please take over in this tab, then press Continue.'
    this.recordStep(toolCall)

    if (!this.onUserInput) {
      this.memory.recordFailure('ask_user', 'Nobody can be asked here. Finish with status "blocked" and say what the user must do.')
      return null
    }

    await setAgentInputLock(this.targetId, false)
    if (this.visualFeedback) await setAgentOverlay(this.targetId, false).catch(() => undefined)
    this.events.onStatus?.(`Waiting for you: ${question}`)

    let reply: string | null
    try {
      reply = await this.onUserInput({ question })
    } finally {
      if (!this.signal?.aborted) {
        await setAgentInputLock(this.targetId, true)
        if (this.visualFeedback) await setAgentOverlay(this.targetId, true).catch(() => undefined)
      }
    }
    if (this.signal?.aborted) return this.finalResult('failed', 'Task was stopped by the user.', 'cancelled')
    if (reply === null) return this.finalResult('failed', `Stopped at your request while waiting for: ${question}`, 'declined')

    // Popups the user opened while signing in are theirs, not the agent's.
    this.takeOpenedTabs?.(this.targetId)
    const answer = reply.trim() || 'done'
    this.memory.recordMilestone(`Asked the user: "${question.slice(0, 120)}" — the user replied: "${answer.slice(0, 300)}"`)
    this.memory.recordStep('ask_user', `The user handled it and replied: "${answer.slice(0, 120)}"`, true)
    this.memory.resetRetries()
    this.guardRejectionStreak = 0
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

    if (toolCall.tool === 'type' && text !== null) {
      // Short text (a slide title, a cell) is below the content ledger's
      // threshold but is still progress the planner must not lose track of.
      const label = this.targetLabel(targetId, pageState)
      this.memory.recordMilestone(
        `Typed "${text.replace(/\s+/g, ' ').slice(0, 80)}"${label ? ` into ${label}` : ''} on ${documentKey(pageState.url)}`,
      )
      return
    }

    if (toolCall.tool === 'press_key' && typeof args.key === 'string' && args.key.length > 1 && args.key.includes('+')) {
      // Shortcuts create things (Control+m adds a slide); keep a durable count.
      this.memory.recordMilestone(`Pressed shortcut ${args.key} on ${documentKey(pageState.url)}`)
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

    if (toolCall.tool === 'go_back') {
      this.memory.recordMilestone(`Went back from ${documentKey(pageState.url)}`)
      return
    }

    if (toolCall.tool === 'select_option' && typeof args.option === 'string') {
      this.memory.recordMilestone(
        `Chose "${args.option.slice(0, 60)}" in ${this.targetLabel(targetId, pageState) ?? 'a dropdown'}${reason ? ` — ${reason}` : ''}`,
      )
      return
    }

    if (toolCall.tool === 'click' && urlChanged) {
      this.memory.recordMilestone(`Clicked ${this.targetLabel(targetId, pageState) ?? 'an element'} on ${documentKey(pageState.url)} — page changed to a new URL`)
    }
  }

  /**
   * ANALYSE: before the first action, turn the goal into a brief. Fails open:
   * without a brief the planner still works step by step, as it always did.
   */
  private async analyse(pageState: PageStateSnapshot): Promise<AgentTaskResult | null> {
    this.analysed = true
    this.events.onStatus?.('Analysing the task: requirements, plan and content…')
    try {
      const { brief } = await requestAnalysis(this.goal, pageState, this.memory.sessionTasks, this.signal)
      this.memory.setTaskBrief(brief)
      this.events.onAnalysis?.(brief)
    } catch (error) {
      if (this.signal?.aborted || isAbortError(error)) {
        return this.finalResult('failed', 'Task was stopped by the user.', 'cancelled')
      }
      if (error instanceof AgentPlanError && error.kind === 'unavailable') {
        return this.finalResult('failed', error.message, 'planner_failed')
      }
      this.events.onStatus?.('Task analysis was unavailable — planning step by step instead.')
    }
    return null
  }

  /**
   * VERIFY: a finish claim is only accepted once an independent check of the
   * evidence (fresh page state + visible page text + the task's own records)
   * confirms every requirement. Otherwise the gaps go back into working memory
   * and planning continues.
   */
  private async finish(toolCall: AgentToolCall, plannedState: PageStateSnapshot): Promise<ActionOutcome> {
    const summary = typeof toolCall.arguments?.summary === 'string' && toolCall.arguments.summary
      ? toolCall.arguments.summary
      : 'Goal achieved.'

    if (toolCall.arguments?.status === 'blocked') {
      this.recordStep(toolCall)
      return this.finalResult('failed', summary, 'blocked')
    }

    this.events.onStatus?.('Self-check: verifying the result against every requirement…')
    const fresh = await extractPageState(this.targetId)
    // Leave the page clean: a tip that appeared late is closed before judging.
    const evidenceState = fresh.ok ? await this.dismissPopups(fresh.data) : plannedState
    const textResult = await invokeRuntime(this.targetId, 'readText', {})
    const pageText = textResult.ok ? observedText(textResult.data.value) : ''

    let verdict: AgentVerification
    try {
      try {
        verdict = await requestVerification(this.goal, summary, this.memory, evidenceState, pageText, this.signal)
      } catch (first) {
        if (!(first instanceof AgentPlanError && first.kind === 'rate_limited')) throw first
        this.events.onStatus?.('Self-check: the AI provider is rate-limiting — retrying in 8s…')
        await new Promise((resolve) => setTimeout(resolve, 8000))
        verdict = await requestVerification(this.goal, summary, this.memory, evidenceState, pageText, this.signal)
      }
    } catch (error) {
      if (this.signal?.aborted || isAbortError(error)) {
        return this.finalResult('failed', 'Task was stopped by the user.', 'cancelled')
      }
      const reason = error instanceof Error ? error.message : 'unknown error'
      this.recordStep(toolCall)
      return this.finalResult('completed', `${summary}\n\n(Self-check unavailable: ${reason})`, undefined, { verified: false })
    }

    if (verdict.complete) {
      this.memory.setSelfCheck(null)
      this.events.onVerification?.(verdict, 'accepted')
      this.recordStep(toolCall)
      return this.finalResult('completed', summary, undefined, { verified: true, checks: verdict.checks })
    }

    this.verificationRejections += 1
    if (this.verificationRejections > MAX_VERIFICATION_REJECTIONS) {
      this.events.onVerification?.(verdict, 'unconfirmed')
      this.recordStep(toolCall)
      return this.finalResult(
        'completed',
        `${summary}\n\nThe self-check could not confirm: ${verdict.missing.join('; ')}`,
        undefined,
        { verified: false, checks: verdict.checks },
      )
    }

    this.events.onVerification?.(verdict, 'rejected')
    this.memory.setSelfCheck({ attempt: this.verificationRejections, missing: verdict.missing, next_step: verdict.next_step })
    this.memory.recordFailure(
      'finish',
      `SELF-CHECK REJECTED the finish: still missing ${verdict.missing.join('; ')}` +
        (verdict.next_step ? `. Suggested next step: ${verdict.next_step}` : ''),
      'VERIFICATION_FAILED',
    )
    this.memory.recordStep('finish', `Claimed done; the self-check found work still missing (${verdict.missing.length} item(s)).`, false)
    this.events.onStatus?.(`Self-check: not done yet — ${verdict.missing[0] ?? 'requirements unmet'}. Continuing…`)
    return null
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
    review: Pick<AgentTaskResult, 'verified' | 'checks'> = {},
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
    return { taskId: this.taskId, status, message, steps: this.stepCount, reason, ...review }
  }
}
