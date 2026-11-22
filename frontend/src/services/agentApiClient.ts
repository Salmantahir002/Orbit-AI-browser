import type {
  AgentPlanRequest,
  AgentPlanResponse,
  AgentSessionTaskRecord,
  AgentTaskBrief,
  AgentVerification,
} from '../types/agentTypes'
import type { PageStateSnapshot } from '../types/browserRuntimeTypes'
import type { AgentWorkingMemory } from './agentWorkingMemory'

/**
 * Backend client for the autonomous agent runtime.
 *
 * Deliberately separate from `backendApiClient.ts`. The agent subsystem must
 * stay isolated from the manual Orbit Scan and chat flows in routing, request
 * lifecycle, and error handling, so it does not share their transport either.
 */

const AGENT_API_BASE_URL = 'http://127.0.0.1:8000/api/v1'
const PLAN_TIMEOUT_MS = 90_000

export type AgentPlanFailure = {
  kind: 'unavailable' | 'invalid_plan' | 'llm_error' | 'rate_limited' | 'network'
  message: string
}

export class AgentPlanError extends Error {
  readonly kind: AgentPlanFailure['kind']

  constructor(kind: AgentPlanFailure['kind'], message: string) {
    super(message)
    this.name = 'AgentPlanError'
    this.kind = kind
  }
}

function classifyStatus(status: number): AgentPlanFailure['kind'] {
  if (status === 503) return 'unavailable'
  if (status === 422) return 'invalid_plan'
  if (status === 429) return 'rate_limited'
  return 'llm_error'
}

function extractDetail(raw: string, status: number): string {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.detail === 'string') {
      return parsed.detail
    }
  } catch {
    // raw text
  }
  return raw.trim() || `Planner failed with status ${status}`
}

function combine(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeoutSignal
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

/** POSTs to an agent endpoint, mapping every failure onto AgentPlanError. */
async function postAgent<T>(path: string, body: unknown, label: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${AGENT_API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: combine(signal, timeoutMs),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new AgentPlanError('network', `${label} timed out after ${Math.round(timeoutMs / 1000)}s.`)
    }
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new AgentPlanError('network', 'Agent backend is not reachable. Ensure the Node.js backend is running on port 8000.')
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    throw new AgentPlanError(classifyStatus(response.status), extractDetail(raw, response.status))
  }
  return response.json() as Promise<T>
}

/**
 * Before the first action: the goal becomes a brief of acceptance criteria,
 * sub-goals and drafted content. Creation tasks draft a lot of text, so this
 * gets a longer timeout than a single plan.
 */
export async function requestAnalysis(
  goal: string,
  pageState: PageStateSnapshot,
  sessionHistory: readonly AgentSessionTaskRecord[],
  signal?: AbortSignal,
): Promise<{ brief: AgentTaskBrief; playbooks: string[] }> {
  return postAgent('/agent/analyze', {
    goal,
    page_state: { url: pageState.url, title: pageState.title },
    session_history: sessionHistory,
  }, 'Task analysis', 75_000, signal)
}

/** When the planner claims it is done: an independent, evidence-based check. */
export async function requestVerification(
  goal: string,
  claimedSummary: string,
  memory: AgentWorkingMemory,
  pageState: PageStateSnapshot,
  pageText: string,
  signal?: AbortSignal,
): Promise<AgentVerification> {
  return postAgent('/agent/verify', {
    goal,
    claimed_summary: claimedSummary,
    working_memory: memory.snapshot(),
    page_state: pageState,
    page_text: pageText,
  }, 'Self-check', 60_000, signal)
}

/**
 * Asks the planner for the next action.
 *
 * A 422 means the model produced something that failed tool validation — that
 * is a recoverable planning error, not an outage, so it is reported distinctly
 * for the Phase 6 recovery engine to branch on.
 */
export async function requestPlan(
  goal: string,
  memory: AgentWorkingMemory,
  pageState: PageStateSnapshot,
  signal?: AbortSignal,
): Promise<AgentPlanResponse> {
  const body: AgentPlanRequest = {
    goal,
    working_memory: memory.snapshot(),
    page_state: pageState,
  }

  // Reasoning models regularly take 30-60s on a large page; a timeout that
  // fires first turns a slow-but-fine plan into a failure and a retry.
  const timeoutSignal = AbortSignal.timeout(PLAN_TIMEOUT_MS)
  const combinedSignal = signal
    ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal)
    : timeoutSignal

  let response: Response
  try {
    response = await fetch(`${AGENT_API_BASE_URL}/agent/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: combinedSignal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new AgentPlanError('network', `Agent planner request timed out after ${PLAN_TIMEOUT_MS / 1000}s. Backend or AI provider is unresponsive.`)
    }
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new AgentPlanError('network', 'Agent backend is not reachable. Ensure the Node.js backend is running on port 8000.')
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    const message = extractDetail(raw, response.status)
    throw new AgentPlanError(classifyStatus(response.status), message)
  }

  return response.json() as Promise<AgentPlanResponse>
}
