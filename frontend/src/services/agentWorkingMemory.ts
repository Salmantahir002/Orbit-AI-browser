import type {
  AgentContentEntry,
  AgentFailureRecord,
  AgentProgressItem,
  AgentSessionTaskRecord,
  AgentStepRecord,
  AgentWorkingMemorySnapshot,
} from '../types/agentTypes'

/**
 * Working Memory for one agent task.
 *
 * The planner is stateless; this is what carries continuity between planning
 * cycles. It holds a bounded, structured summary — goal, what has been done,
 * what is still outstanding, what failed — rather than a conversation
 * transcript. That keeps each prompt small and, importantly, stops content
 * from previously visited pages accumulating in the planner's context where a
 * stale injection attempt could still influence it.
 *
 * It is layered by how long each fact must survive:
 *
 *  - `completedSteps` / `failures` — a rolling log of recent actions. Old
 *    entries fall off; that is fine for "which button did I just click".
 *  - `milestones` — durable facts about progress (opened this document, typed
 *    that letter). These must NOT fall off: once the record that the letter
 *    was typed scrolls out of the rolling log, the planner re-derives "the
 *    document is empty" from a page whose body it cannot see, and types it
 *    again. That is the loop this layer exists to break.
 *  - `contentLedger` — every piece of text the agent entered, with a
 *    fingerprint so a re-type of the same (or reworded) text can be refused
 *    before it reaches the page.
 *  - `planProgress` — the planner's own checklist for the goal, echoed back
 *    every round so it always knows which sub-goal it is on.
 */

const MAX_COMPLETED_STEPS = 40
const MAX_FAILURES = 20
const MAX_MILESTONES = 40
const MAX_CONTENT_ENTRIES = 30
const MAX_PROGRESS_ITEMS = 15

/** Below this, text is a search query or a form value, not authored content. */
export const CONTENT_MIN_CHARS = 40
/** Across different pages only long, authored text is treated as a re-type. */
const CROSS_PAGE_CONTENT_MIN_CHARS = 200

const PREVIEW_CHARS = 90

// ---------------------------------------------------------------- similarity

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim()
}

function shingles(words: string[], size: number): Set<string> {
  const result = new Set<string>()
  for (let index = 0; index + size <= words.length; index++) {
    result.add(words.slice(index, index + size).join(' '))
  }
  return result
}

/** |A ∩ B| / min(|A|, |B|) — a rewrite of a longer text still scores high. */
function overlapCoefficient(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  let shared = 0
  for (const item of small) if (large.has(item)) shared += 1
  return shared / small.size
}

/** A short text inside a long one is a heading or a title, not a copy of it. */
const SUBSTANTIAL_CHARS = 200
const SUBSTANTIAL_RATIO = 0.5

/**
 * True when `candidate` is the same text as `previous`, a large fragment of
 * it, or a reworded version of it. A continuation (the next paragraph of the
 * same letter) shares few word triples with what came before and passes.
 *
 * Every measure below compares against the *smaller* text, so it is only
 * meaningful when both are of comparable size: a document title is fully
 * contained in the letter that follows it, and must not block that letter.
 */
export function isNearDuplicateText(previous: string, candidate: string): boolean {
  const left = normalizeText(previous)
  const right = normalizeText(candidate)
  if (!left || !right) return false
  if (left === right) return true

  const shorter = Math.min(left.length, right.length)
  const longer = Math.max(left.length, right.length)
  if (shorter < SUBSTANTIAL_CHARS && shorter / longer < SUBSTANTIAL_RATIO) return false

  if (left.includes(right) || right.includes(left)) return true

  const leftWords = left.split(' ')
  const rightWords = right.split(' ')
  if (leftWords.length < 8 || rightWords.length < 8) return false

  // Measured on real re-typed letters: rewrites of the same letter score
  // 0.33–0.48 (triples), 0.49–0.67 (pairs) and 0.70–0.89 (content words);
  // the next paragraph of the same letter scores under 0.1 on all three.
  const leftContent = contentWords(leftWords)
  const rightContent = contentWords(rightWords)
  return (
    overlapCoefficient(shingles(leftWords, 3), shingles(rightWords, 3)) >= 0.4 ||
    overlapCoefficient(shingles(leftWords, 2), shingles(rightWords, 2)) >= 0.45 ||
    (Math.min(leftContent.size, rightContent.size) >= 12 && overlapCoefficient(leftContent, rightContent) >= 0.6)
  )
}

const STOP_WORDS = new Set(
  'a an the of to in and or for on at by with from this that is it its my your our i am be are was were as under not'.split(' '),
)

function contentWords(words: string[]): Set<string> {
  return new Set(words.filter((word) => word.length > 2 && !STOP_WORDS.has(word)))
}

/** Query strings and fragments do not identify a different document. */
export function documentKey(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url
  }
}

function preview(text: string, fromEnd = false): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= PREVIEW_CHARS) return flat
  return fromEnd ? `…${flat.slice(-PREVIEW_CHARS)}` : `${flat.slice(0, PREVIEW_CHARS)}…`
}

export type DuplicateContentMatch = {
  entry: AgentContentEntry
  samePage: boolean
}

// -------------------------------------------------------------------- memory

type LedgerEntry = AgentContentEntry & { fullText: string }

/** The full text stays local: only previews are ever sent to the planner. */
function publicEntry(entry: LedgerEntry): AgentContentEntry {
  return {
    step: entry.step,
    tool: entry.tool,
    target: entry.target,
    page: entry.page,
    chars: entry.chars,
    head: entry.head,
    tail: entry.tail,
    status: entry.status,
  }
}

export class AgentWorkingMemory {
  readonly goal: string

  private completedSteps: AgentStepRecord[] = []
  private pendingSteps: string[] = []
  private failures: AgentFailureRecord[] = []
  private retries = 0
  private currentPage = ''
  private extractedKnowledge: string[] = []
  private invalidElements = new Set<string>()
  private lastThought = ''
  private stepNumber = 0
  private planProgress: AgentProgressItem[] = []
  private milestones: string[] = []
  private contentLedger: LedgerEntry[] = []
  private readonly sessionHistory: AgentSessionTaskRecord[]

  constructor(goal: string, sessionHistory: readonly AgentSessionTaskRecord[] = []) {
    this.goal = goal.trim()
    this.sessionHistory = [...sessionHistory]
  }

  /** Advances the task's step counter; called once per executed action. */
  beginStep(): number {
    this.stepNumber += 1
    return this.stepNumber
  }

  get currentStep(): number {
    return this.stepNumber
  }

  recordStep(tool: string, summary: string, succeeded = true): void {
    this.completedSteps.push({ tool, summary, succeeded, step: this.stepNumber })
    if (this.completedSteps.length > MAX_COMPLETED_STEPS) {
      // Drop the oldest: recent history is what informs the next action.
      this.completedSteps = this.completedSteps.slice(-MAX_COMPLETED_STEPS)
    }
  }

  recordFailure(tool: string, reason: string, code?: string): void {
    this.failures.push({ tool, reason, code })
    if (this.failures.length > MAX_FAILURES) {
      this.failures = this.failures.slice(-MAX_FAILURES)
    }
  }

  recordFinding(note: string): void {
    const trimmed = (note ?? '').trim()
    if (trimmed && !this.extractedKnowledge.includes(trimmed)) {
      this.extractedKnowledge.push(trimmed)
      if (this.extractedKnowledge.length > 100) {
        this.extractedKnowledge = this.extractedKnowledge.slice(-100)
      }
    }
  }

  /** A durable progress fact. Consecutive duplicates are collapsed. */
  recordMilestone(text: string): void {
    const trimmed = (text ?? '').trim().slice(0, 300)
    if (!trimmed) return
    const entry = `[step ${this.stepNumber}] ${trimmed}`
    const last = this.milestones[this.milestones.length - 1]
    if (last && last.replace(/^\[step \d+\] /, '') === trimmed) return
    this.milestones.push(entry)
    if (this.milestones.length > MAX_MILESTONES) {
      // Keep the first milestones (where the task started) and the most recent.
      this.milestones = [...this.milestones.slice(0, 5), ...this.milestones.slice(-(MAX_MILESTONES - 5))]
    }
  }

  /** Records text the agent entered. Returns the ledger entry that was stored. */
  recordContentEntry(
    tool: string,
    text: string,
    page: string,
    status: AgentContentEntry['status'],
    target?: string,
  ): AgentContentEntry {
    const entry: LedgerEntry = {
      step: this.stepNumber,
      tool,
      target,
      page: documentKey(page),
      chars: text.length,
      head: preview(text),
      tail: preview(text, true),
      status,
      fullText: text,
    }
    this.contentLedger.push(entry)
    if (this.contentLedger.length > MAX_CONTENT_ENTRIES) {
      this.contentLedger = this.contentLedger.slice(-MAX_CONTENT_ENTRIES)
    }
    return entry
  }

  /**
   * Looks for text this task already delivered that `text` would duplicate.
   * Entries that failed outright are ignored — re-typing those is a retry,
   * not a loop.
   */
  findDuplicateContent(text: string, page: string): DuplicateContentMatch | null {
    if (text.trim().length < CONTENT_MIN_CHARS) return null
    const key = documentKey(page)

    for (let index = this.contentLedger.length - 1; index >= 0; index--) {
      const entry = this.contentLedger[index]
      if (entry.status === 'failed') continue
      const samePage = entry.page === key
      if (!samePage && (text.length < CROSS_PAGE_CONTENT_MIN_CHARS || entry.chars < CROSS_PAGE_CONTENT_MIN_CHARS)) continue
      if (isNearDuplicateText(entry.fullText, text)) {
        return { entry: publicEntry(entry), samePage }
      }
    }
    return null
  }

  recordInvalidElement(elementId: string): void {
    if (elementId && typeof elementId === 'string') {
      this.invalidElements.add(elementId.trim())
    }
  }

  isElementInvalid(elementId: string): boolean {
    return Boolean(elementId && this.invalidElements.has(elementId.trim()))
  }

  setLastThought(thought: string): void {
    this.lastThought = (thought ?? '').trim().slice(0, 500)
  }

  /** Stores the planner's checklist and derives the outstanding steps from it. */
  setPlanProgress(progress: readonly AgentProgressItem[] | undefined): void {
    if (!progress || progress.length === 0) return
    this.planProgress = progress
      .filter((item) => item && typeof item.step === 'string' && item.step.trim())
      .slice(0, MAX_PROGRESS_ITEMS)
      .map((item) => ({ step: item.step.trim().slice(0, 200), status: item.status }))
    this.pendingSteps = this.planProgress.filter((item) => item.status !== 'done').map((item) => item.step)
  }

  get progress(): readonly AgentProgressItem[] {
    return this.planProgress
  }

  get milestoneLog(): readonly string[] {
    return this.milestones
  }

  get findings(): readonly string[] {
    return this.extractedKnowledge
  }

  setPendingSteps(steps: string[]): void {
    this.pendingSteps = [...steps]
  }

  /** Retries are counted per task, and cleared once an action lands. */
  incrementRetries(): number {
    this.retries += 1
    return this.retries
  }

  resetRetries(): void {
    this.retries = 0
  }

  get retryCount(): number {
    return this.retries
  }

  /** Navigating away invalidates outstanding retry state and invalid element IDs for the old page. */
  setCurrentPage(url: string): void {
    if (url !== this.currentPage) {
      this.currentPage = url
      this.retries = 0
      this.invalidElements.clear()
    }
  }

  get page(): string {
    return this.currentPage
  }

  get failureCount(): number {
    return this.failures.length
  }

  /** The serialisable form sent to the planner. */
  snapshot(): AgentWorkingMemorySnapshot {
    return {
      goal: this.goal,
      completed_steps: [...this.completedSteps],
      pending_steps: [...this.pendingSteps],
      failures: [...this.failures],
      retries: this.retries,
      current_page: this.currentPage,
      extracted_knowledge: [...this.extractedKnowledge],
      invalid_elements: Array.from(this.invalidElements),
      last_thought: this.lastThought || undefined,
      step_number: this.stepNumber,
      plan_progress: [...this.planProgress],
      milestones: [...this.milestones],
      content_entered: this.contentLedger.map(publicEntry),
      session_history: [...this.sessionHistory],
    }
  }
}
