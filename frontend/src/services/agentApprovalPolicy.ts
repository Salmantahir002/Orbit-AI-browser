import type { AgentToolCall } from '../types/agentTypes'
import type { PageStateSnapshot, SemanticElement } from '../types/browserRuntimeTypes'

/**
 * Decides which actions need explicit human consent before they run.
 *
 * Two sources feed this:
 *  - the backend tool registry, via `requires_approval` on the tool call;
 *  - a local reading of *what the action would actually do*, since a click is
 *    an ordinary click right up until the button says "Place order".
 *
 * The consequences the spec names — purchases, payments, deletion,
 * irreversible submissions — are not visible in the tool name. They are
 * visible in the accessible name of the control, which is the same text a
 * person would read before deciding.
 */

export type ApprovalRequest = {
  toolCall: AgentToolCall
  /** Short sentence for the dialog: what is about to happen. */
  summary: string
  /** Why consent is being asked, for the dialog's secondary line. */
  reason: string
  risk: 'irreversible' | 'financial' | 'destructive' | 'upload' | 'low_confidence'
}

type Rule = { pattern: RegExp; risk: ApprovalRequest['risk']; reason: string }

/**
 * Word-boundary matching keeps "Buy" from firing on "Buyer's guide" and
 * "pay" from firing on "payload" or "paypal.com/help".
 */
const RULES: readonly Rule[] = [
  {
    pattern: /\b(buy|purchase|order now|place (the )?order|checkout|check out|add to cart|subscribe|book now|reserve)\b/i,
    risk: 'financial',
    reason: 'This looks like it completes a purchase.',
  },
  {
    pattern: /\b(pay|payment|donate|transfer|send money|confirm and pay|authorise|authorize)\b/i,
    risk: 'financial',
    reason: 'This looks like it authorises a payment.',
  },
  {
    pattern: /\b(delete|remove|discard|erase|destroy|deactivate|close account|unsubscribe|cancel (my )?(subscription|account))\b/i,
    risk: 'destructive',
    reason: 'This looks like it deletes something that may not be recoverable.',
  },
  {
    pattern: /\b(submit|send|post|publish|apply now|confirm|agree|accept|sign)\b/i,
    risk: 'irreversible',
    reason: 'This submits a form, which usually cannot be undone.',
  },
]

/**
 * Risk-weighted minimum confidence thresholds per tool.
 * High-consequence or disruptive tools demand higher planner confidence before running
 * autonomously. Passive or easily reversible actions have low or zero thresholds so they
 * never trigger nuisance prompts.
 */
export const TOOL_CONFIDENCE_THRESHOLDS: Readonly<Record<string, number>> = {
  click: 0.0,
  fill: 0.0,
  type: 0.0,
  press_key: 0.0,
  navigate: 0.0,
  open_tab: 0.0,
  scroll: 0.0,
  wait: 0.0,
  extract: 0.0,
  finish: 0.0,
  upload: 1.0,
  evaluate: 0, element_bounds: 0, dispatch_mouse_event: 0, drag: 0, extract_virtual_table: 0,
}

export function getToolConfidenceThreshold(tool: string): number {
  return TOOL_CONFIDENCE_THRESHOLDS[tool] ?? 0.60
}

function describeElement(element: SemanticElement | undefined, fallback: string): string {
  if (!element) return fallback
  return `${element.role} "${element.name}"`
}

function uploadApproval(
  toolCall: AgentToolCall,
  pageState: PageStateSnapshot | null,
  target: SemanticElement | undefined,
): ApprovalRequest {
  const field = describeElement(target, 'a file field')
  const downloadId = toolCall.arguments?.download
  if (downloadId === undefined) {
    return {
      toolCall,
      summary: `Attach files to ${field}`,
      reason: 'You will choose the files yourself; the agent cannot pick them.',
      risk: 'upload',
    }
  }

  // The agent picked this file, so the dialog must say exactly which one and
  // where it is going: this is the user's only chance to stop it.
  const file = pageState?.downloads?.find((download) => download.id === downloadId)
  const site = pageState?.url ? hostOf(pageState.url) : ''
  return {
    toolCall,
    summary: `Attach "${file?.filename ?? 'a downloaded file'}" to ${field}${site ? ` on ${site}` : ''}`,
    reason: 'The agent chose this file from your Downloads in this session. Approve only if you want it sent to this site.',
    risk: 'upload',
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * Returns an approval request when consent is required, or null to proceed.
 * Applies risk-weighted confidence thresholds: high-impact tools demand higher certainty,
 * while harmless tools (scroll, wait, extract) proceed without user interruptions.
 */
export function approvalFor(
  toolCall: AgentToolCall,
  pageState: PageStateSnapshot | null,
  options: { lowConfidence?: boolean; confidence?: number } = {},
): ApprovalRequest | null {
  const target = typeof toolCall.arguments?.target === 'string'
    ? pageState?.elements.find((element) => element.id === toolCall.arguments.target)
    : undefined

  if (toolCall.requires_approval || toolCall.tool === 'upload') {
    return uploadApproval(toolCall, pageState, target)
  }

  // Only actions that actually commit something are worth interrupting for.
  // Typing into a field or scrolling is freely reversible.
  if (toolCall.tool === 'click' || toolCall.tool === 'press_key') {
    const label = target
      ? `${target.name} ${target.description ?? ''}`
      : String(toolCall.arguments?.key ?? '')

    const cookieContext = [label, ...(pageState?.dialogs.map(dialog => JSON.stringify(dialog)) ?? [])].join(' ')
    const cookieDismissal = /cookie|consent preferences/i.test(cookieContext) && /^(accept( all)?|reject( all)?|agree|allow( all)?|close|dismiss|save preferences)\b/i.test(target?.name ?? '')
    const matched = cookieDismissal ? undefined : RULES.find((rule) => rule.pattern.test(label))
    if (matched) {
      return {
        toolCall,
        summary: `Click ${describeElement(target, 'a control')}`,
        reason: matched.reason,
        risk: matched.risk,
      }
    }
  }

  // Risk-weighted confidence gating:
  const threshold = getToolConfidenceThreshold(toolCall.tool)
  // Reversible, passive actions with a 0 threshold never pause for low confidence
  if (threshold > 0) {
    const confidence = typeof options.confidence === 'number' ? options.confidence : undefined
    const isBelowThreshold = confidence !== undefined
      ? confidence < threshold
      : Boolean(options.lowConfidence)

    if (isBelowThreshold) {
      const percent = Math.round((confidence ?? 0) * 100)
      const thresholdPercent = Math.round(threshold * 100)
      return {
        toolCall,
        summary: `${toolCall.tool} ${describeElement(target, '')}`.trim(),
        reason: `Planner confidence (${percent}%) is below the ${thresholdPercent}% threshold required for ${toolCall.tool}.`,
        risk: 'low_confidence',
      }
    }
  }

  return null
}

/** Resolves an approval request. The UI supplies the implementation. */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>
