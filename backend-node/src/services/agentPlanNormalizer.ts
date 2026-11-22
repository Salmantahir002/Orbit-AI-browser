// Turns what models actually write into what the tool registry accepts.
//
// Most "invalid tool call" failures are not wrong decisions; they are spelling:
// `goto` for navigate, `{"element": 12}` for `{"target": "e12"}`, a `type`
// aimed at a field, a queue one action too long, an extra argument nobody
// asked for. Each of those used to cost a full planning round trip (and a
// failure-streak point). This layer fixes the spelling only. Every action it
// returns still goes through validateToolCall/validateToolQueue unchanged, so
// it cannot widen what the planner may do: an unknown tool stays unknown, a
// non-http url is still refused, an invented element id is still rejected.
import {
  MAX_QUEUE_LENGTH,
  TOOLS_BY_NAME,
  ToolValidationError,
  validateToolQueue,
} from './agentToolRegistry.js'

const TOOL_ALIASES: Record<string, string> = {
  click_element: 'click', click_button: 'click', click_link: 'click', tap: 'click', press_button: 'click',
  input: 'fill', input_text: 'fill', fill_input: 'fill', fill_field: 'fill', fill_text: 'fill', set_value: 'fill', enter_text: 'fill', type_into: 'fill',
  type_text: 'type', write: 'type', insert_text: 'type', keyboard_type: 'type', write_text: 'type',
  press: 'press_key', key: 'press_key', keypress: 'press_key', key_press: 'press_key', hotkey: 'press_key', shortcut: 'press_key', send_keys: 'press_key', keyboard_shortcut: 'press_key',
  goto: 'navigate', go_to: 'navigate', open_url: 'navigate', visit: 'navigate', load_url: 'navigate', browse: 'navigate', navigate_to: 'navigate', go_to_url: 'navigate',
  new_tab: 'open_tab', open_new_tab: 'open_tab',
  scroll_down: 'scroll', scroll_up: 'scroll', scroll_page: 'scroll',
  sleep: 'wait', pause: 'wait', wait_for: 'wait', wait_for_load: 'wait',
  note: 'extract', record: 'extract', remember: 'extract', extract_info: 'extract', save_finding: 'extract',
  done: 'finish', complete: 'finish', finish_task: 'finish', task_complete: 'finish', end: 'finish', final_answer: 'finish', answer: 'finish', stop: 'finish',
  click_on_text: 'click_text', click_label: 'click_text',
  read_page: 'read_text', get_text: 'read_text', page_text: 'read_text', get_page_text: 'read_text', read: 'read_text',
  select: 'select_option', choose: 'select_option', choose_option: 'select_option', select_dropdown: 'select_option', dropdown: 'select_option',
  back: 'go_back', navigate_back: 'go_back', history_back: 'go_back', browser_back: 'go_back',
  mouse_over: 'hover', mouseover: 'hover', hover_element: 'hover', hover_over: 'hover',
  ask: 'ask_user', ask_human: 'ask_user', request_user: 'ask_user', human_input: 'ask_user', user_input: 'ask_user', handoff: 'ask_user', request_help: 'ask_user',
}

/** Argument spellings per canonical parameter name. */
const ARGUMENT_ALIASES: Record<string, readonly string[]> = {
  target: ['element', 'element_id', 'elementId', 'id', 'ref', 'element_ref', 'target_id', 'targetId'],
  value: ['text', 'input', 'content', 'query'],
  text: ['value', 'content', 'input', 'string'],
  key: ['keys', 'key_combo', 'combo', 'shortcut', 'hotkey'],
  url: ['href', 'link', 'address', 'website'],
  summary: ['answer', 'result', 'message', 'output', 'final_answer', 'response'],
  note: ['text', 'finding', 'content', 'info', 'information'],
  option: ['value', 'label', 'choice', 'text', 'option_text'],
  question: ['message', 'prompt', 'text', 'request'],
  expression: ['script', 'code', 'js', 'javascript'],
  timeoutMs: ['timeout', 'ms', 'milliseconds', 'duration'],
}

const MAX_SCROLL = 3_000
const DEFAULT_SCROLL = 600

export interface NormalizedQueue {
  actions: Array<[string, Record<string, unknown>]>
  /** What was changed or dropped, for logs. Never shown to the planner as success. */
  notes: string[]
}

function canonicalToolName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const key = raw.trim().replace(/[\s-]+/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
  if (TOOLS_BY_NAME.has(key)) return key
  return TOOL_ALIASES[key] ?? raw.trim()
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

/** e12, "12", 12, "[e12]", "#E12" → "e12". Anything else is returned as given. */
export function normalizeElementId(value: unknown): unknown {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return `e${value}`
  if (typeof value !== 'string') return value
  const match = /^\s*\[?#?\s*e?(\d+)\s*\]?\s*$/i.exec(value)
  return match ? `e${Number(match[1])}` : value.trim()
}

function normalizeUrl(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  // A bare host ("youtube.com/results?…") is what a person types in an
  // address bar; anything with a scheme is left for validation to judge.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  if (/^(www\.)?[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/i.test(trimmed)) return `https://${trimmed}`
  return trimmed
}

/** Pulls `{tool, arguments}` out of the shapes models emit for one action. */
function splitAction(raw: unknown): { name?: string; args: Record<string, unknown> } {
  if (typeof raw === 'string') return { name: canonicalToolName(raw), args: {} }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { args: {} }
  const record = raw as Record<string, unknown>

  // OpenAI-style {"function": {"name": ..., "arguments": "{...}"}}
  const fn = record.function && typeof record.function === 'object' ? record.function as Record<string, unknown> : null
  const name = canonicalToolName(record.tool ?? record.name ?? record.action ?? fn?.name ?? record.tool_name)
  let args = parseMaybeJson(record.arguments ?? record.args ?? record.parameters ?? record.params ?? record.input ?? fn?.arguments)
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    // Arguments written beside the tool name: {"tool": "click", "target": "e3"}.
    const loose: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      if (!['tool', 'name', 'action', 'function', 'tool_name', 'arguments', 'args', 'parameters', 'params', 'requires_approval', 'reason', 'thought'].includes(key)) {
        loose[key] = value
      }
    }
    args = loose
  }
  return { name, args: { ...(args as Record<string, unknown>) } }
}

/**
 * Maps one action's spelling onto its tool's parameters. Returns one or two
 * actions: a `type` aimed at an element becomes click-then-type, because
 * `type` writes wherever focus is and `fill` would erase what is there.
 */
function normalizeAction(raw: unknown, notes: string[]): unknown[] {
  const { name, args } = splitAction(raw)
  if (!name) return [raw]
  const spec = TOOLS_BY_NAME.get(name)
  if (!spec) return [{ tool: name, arguments: args }] // left for validation to reject

  // type/fill with the wrong addressing.
  if (name === 'type' && (args.target !== undefined || args.element !== undefined || args.element_id !== undefined)) {
    const target = normalizeElementId(args.target ?? args.element ?? args.element_id)
    const text = args.text ?? args.value ?? args.content
    notes.push(`type with a target became click ${String(target)} + type`)
    return [{ tool: 'click', arguments: { target } }, { tool: 'type', arguments: { text } }]
  }
  if (name === 'fill' && args.target === undefined && args.element === undefined && args.element_id === undefined && args.id === undefined) {
    notes.push('fill without a target became type')
    return [{ tool: 'type', arguments: { text: args.value ?? args.text } }]
  }

  // scroll by direction ("scroll_down", {"direction": "up", "amount": 400}, {"dy": 300}).
  if (name === 'scroll' && args.deltaY === undefined && args.deltaX === undefined) {
    if (args.dy !== undefined || args.dx !== undefined) {
      if (args.dy !== undefined) args.deltaY = args.dy
      if (args.dx !== undefined) args.deltaX = args.dx
    } else {
      const direction = String(args.direction ?? (splitActionName(raw).endsWith('_up') ? 'up' : 'down')).toLowerCase()
      const amount = Math.min(Math.abs(Number(args.amount ?? args.pixels ?? args.distance ?? DEFAULT_SCROLL)) || DEFAULT_SCROLL, MAX_SCROLL)
      if (direction === 'up') args.deltaY = -amount
      else if (direction === 'left') args.deltaX = -amount
      else if (direction === 'right') args.deltaX = amount
      else args.deltaY = amount
    }
    for (const key of ['dy', 'dx', 'direction', 'amount', 'pixels', 'distance']) delete args[key]
  }

  // press_key given as a list: ["Control", "m"].
  if (name === 'press_key') {
    const keys = args.key ?? args.keys
    if (Array.isArray(keys) && keys.every((key) => typeof key === 'string')) args.key = keys.join('+')
  }

  const cleaned: Record<string, unknown> = {}
  for (const param of spec.parameters) {
    let value = args[param.name]
    if (value === undefined) {
      for (const alias of ARGUMENT_ALIASES[param.name] ?? []) {
        if (args[alias] !== undefined && !spec.parameters.some((p) => p.name === alias)) {
          value = args[alias]
          break
        }
      }
    }
    if (value === undefined || value === null) continue
    if (param.kind === 'element_id') value = normalizeElementId(value)
    else if (param.kind === 'url') value = normalizeUrl(value)
    else if (param.kind === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) value = Number(value)
    else if (param.kind === 'string' && (typeof value === 'number' || typeof value === 'boolean')) value = String(value)
    cleaned[param.name] = value
  }

  const dropped = Object.keys(args).filter((key) => args[key] !== undefined && !(key in cleaned) && !Object.values(ARGUMENT_ALIASES).some((aliases) => aliases.includes(key)))
  if (dropped.length > 0) notes.push(`${name}: dropped unknown argument(s) ${dropped.join(', ')}`)
  return [{ tool: name, arguments: cleaned }]
}

function splitActionName(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const record = raw as Record<string, unknown>
  const value = record.tool ?? record.name ?? record.action
  return typeof value === 'string' ? value.toLowerCase() : ''
}

/** The action list, whichever key the model put it under. */
export function extractRawActions(payload: Record<string, unknown>): unknown[] {
  for (const key of ['actions', 'tool_calls', 'next_actions', 'steps_to_take', 'commands']) {
    const value = payload[key]
    if (Array.isArray(value) && value.length > 0) return value
    if (value && typeof value === 'object') return [value]
  }
  if (payload.action && typeof payload.action === 'object') return Array.isArray(payload.action) ? payload.action : [payload.action]
  if ('tool' in payload || 'function' in payload || (typeof payload.action === 'string')) return [payload]
  throw new ToolValidationError("Planner response contained no 'actions' array or 'tool' field.")
}

/**
 * Normalises and validates a queue, keeping the longest valid prefix.
 *
 * The first action must be valid on its own — there is nothing to salvage
 * from a plan whose first step is wrong, so that error goes back to the
 * planner. A later action that breaks a queue rule (follows navigate, follows
 * an observation, invents an id) is dropped together with everything after
 * it: the actions before it are still correct, and the planner re-plans the
 * rest against the page they produce.
 */
export function normalizeToolQueue(
  rawActions: unknown[],
  knownElementIds?: readonly string[],
  knownDownloadIds?: readonly string[],
): NormalizedQueue {
  const notes: string[] = []
  const expanded = rawActions.flatMap((raw) => normalizeAction(raw, notes))
  if (expanded.length === 0) throw new ToolValidationError('Planner must return at least one tool call.')

  let candidates = expanded
  if (candidates.length > MAX_QUEUE_LENGTH) {
    notes.push(`queue of ${candidates.length} cut to ${MAX_QUEUE_LENGTH}`)
    candidates = candidates.slice(0, MAX_QUEUE_LENGTH)
  }

  // The first action decides whether there is a plan at all.
  let validated = validateToolQueue([candidates[0]], knownElementIds, knownDownloadIds)
  for (let index = 1; index < candidates.length; index++) {
    try {
      validated = validateToolQueue(candidates.slice(0, index + 1), knownElementIds, knownDownloadIds)
    } catch (exc) {
      notes.push(`dropped action ${index + 1} and after: ${exc instanceof Error ? exc.message : String(exc)}`)
      break
    }
  }
  return { actions: validated, notes }
}
