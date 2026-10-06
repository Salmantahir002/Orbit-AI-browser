// Port of backend/app/services/agent_tool_registry.py — the single source of
// truth for what the planner is allowed to emit. Same specs generate the
// prompt documentation AND validate the model's reply (see render_tool_catalogue
// and validate_tool_call/validate_tool_queue). No LLM dependency, so this ports
// independently of the Phase 4 planner/gateway work.

const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:'])
const MAX_TEXT_ARGUMENT_LENGTH = 5_000

export class ToolValidationError extends Error {}

export type ToolParameterKind = 'string' | 'number' | 'element_id' | 'url'

export interface ToolParameter {
  name: string
  kind: ToolParameterKind
  required: boolean
  description: string
}

export interface ToolSpec {
  name: string
  description: string
  parameters: readonly ToolParameter[]
  /** Which subsystem executes the tool. New categories need no planner change. */
  category: string
  /** When true the runtime must obtain explicit human consent before executing. */
  requiresApproval: boolean
  /** True for tools the runtime resolves itself rather than sending to the browser. */
  handledByLoop: boolean
}

function param(name: string, kind: ToolParameterKind, required: boolean, description: string): ToolParameter {
  return { name, kind, required, description }
}

function spec(partial: Partial<ToolSpec> & Pick<ToolSpec, 'name' | 'description'>): ToolSpec {
  return {
    parameters: [],
    category: 'browser',
    requiresApproval: false,
    handledByLoop: false,
    ...partial,
  }
}

/** Compact one-line planner-prompt form, e.g. `{"tool": "click", "arguments": {"target": <element_id>}}`. */
export function toolSignature(s: ToolSpec): string {
  if (s.parameters.length === 0) return `{"tool": "${s.name}"}`
  const rendered = s.parameters
    .map((p) => `"${p.name}": <${p.kind}${p.required ? '' : '?'}>`)
    .join(', ')
  return `{"tool": "${s.name}", "arguments": {${rendered}}}`
}

const TOOL_SPECS: readonly ToolSpec[] = [
  spec({
    name: 'evaluate',
    description: 'Evaluate JavaScript in the guest page and return JSON data to working memory. Include description: a short plain-language label naming what you are checking, such as Checking that winnings are sorted highest first. Inspect the result next.',
    parameters: [param('expression', 'string', true, 'expression'), param('timeoutMs', 'number', false, 'timeoutMs'), param('description', 'string', false, 'Short user-facing description of what is being checked')],
  }),
  spec({
    name: 'element_bounds',
    description: 'Get viewport CSS bounds for a selector (open shadow roots: host >>> child).',
    parameters: [param('selector', 'string', true, 'selector')],
  }),
  spec({
    name: 'dispatch_mouse_event',
    description: 'Send CDP Input.dispatchMouseEvent with viewport CSS coordinates: mousePressed, mouseMoved, mouseReleased or mouseWheel.',
    parameters: [param('type', 'string', true, 'type'), param('x', 'number', true, 'x'), param('y', 'number', true, 'y'), param('button', 'string', false, 'button'), param('buttons', 'number', false, 'buttons'), param('clickCount', 'number', false, 'clickCount'), param('deltaX', 'number', false, 'deltaX'), param('deltaY', 'number', false, 'deltaY'), param('modifiers', 'number', false, 'modifiers')],
  }),
  spec({
    name: 'drag',
    description: 'Drag with native press, interpolated moves and guaranteed release. Verify resulting DOM order.',
    parameters: [param('startX', 'number', true, 'startX'), param('startY', 'number', true, 'startY'), param('endX', 'number', true, 'endX'), param('endY', 'number', true, 'endY'), param('steps', 'number', false, 'steps')],
  }),
  spec({
    name: 'extract_virtual_table',
    description: 'Capture contiguous top N virtual rows with native wheel events and fresh DOM reads. Deduplicates stable IDs and returns completeness, row evidence and TSV. Inspect selectors first.',
    parameters: [param('rowSelector', 'string', true, 'rowSelector'), param('scrollSelector', 'string', true, 'scrollSelector'), param('columns', 'string', true, 'columns'), param('keyAttribute', 'string', true, 'keyAttribute'), param('indexAttribute', 'string', true, 'indexAttribute'), param('startIndex', 'number', false, 'startIndex'), param('count', 'number', false, 'count')],
  }),

  spec({
    name: 'click',
    description:
      'Click an element on the page (button, link, option, tab). ' +
      'Never use click on a Search button before entering the search query into the search input.',
    parameters: [param('target', 'element_id', true, 'Element id from the page state, e.g. e4')],
  }),
  spec({
    name: 'fill',
    description:
      "Replace the contents of an editable input field (role 'textbox', 'searchbox', 'combobox', 'input') " +
      'with a text value. Always use this to enter search queries, form data, or filter/setting values ' +
      "(e.g. a price, quantity, or date field) — prefer it over 'type' whenever the field has an element id. " +
      'In an email To/Cc field it also commits each address as a recipient; no Enter is needed afterwards.',
    parameters: [
      param('target', 'element_id', true, 'Element id of the input field'),
      param('value', 'string', true, 'Text to enter'),
    ],
  }),
  spec({
    name: 'type',
    description:
      'Type text into whatever currently has focus (e.g. a rich-text/document editor body after clicking into it). ' +
      'Appends at the cursor; it never replaces. Send long content in one call with \\n for new lines. ' +
      'Text listed under CONTENT ALREADY ENTERED must never be typed again.',
    parameters: [param('text', 'string', true, 'Text to type')],
  }),
  spec({
    name: 'press_key',
    description:
      'Press a single key inside the page, e.g. Enter, Tab, Escape, ArrowDown. ' +
      "Use 'Enter' after 'fill' to submit a search. " +
      'Browser-level shortcuts such as Control+t or Control+w have no effect here ' +
      '— use open_tab to open a tab.',
    parameters: [param('key', 'string', true, 'Key name')],
  }),
  spec({
    name: 'navigate',
    description: 'Load a new http(s) url.',
    parameters: [param('url', 'url', true, 'Absolute http or https url')],
  }),
  spec({
    name: 'open_tab',
    description:
      'Open a new browser tab and switch to it, optionally loading a url. ' +
      'This is the only way to open a tab. To load a url in the tab already ' +
      'showing, use navigate instead.',
    parameters: [param('url', 'url', false, 'Absolute http or https url to open in the new tab')],
    handledByLoop: true,
  }),
  spec({
    name: 'scroll',
    description: 'Scroll the page or an element. Positive deltaY scrolls down.',
    parameters: [
      param('target', 'element_id', false, 'Element to scroll over'),
      param('deltaX', 'number', false, 'Horizontal pixels'),
      param('deltaY', 'number', false, 'Vertical pixels'),
    ],
  }),
  spec({
    name: 'upload',
    description: 'Attach files to a file input. Always asks the user to choose the files.',
    parameters: [param('target', 'element_id', true, 'Element id of the file input')],
    category: 'files',
    requiresApproval: true,
  }),
  spec({
    name: 'wait',
    description:
      'Wait for the page to finish loading or settle. Rarely needed: click/fill/type/press_key ' +
      'already wait for the page to settle before returning, so do not queue this right after one ' +
      'of them — only use it when something is loading that none of your actions triggered.',
    parameters: [param('timeoutMs', 'number', false, 'Maximum wait in milliseconds')],
  }),
  spec({
    name: 'extract',
    description:
      'Record information from the current page into working memory. The note must describe what ' +
      'is actually visible in the current page state (a field\'s value, the url, the results shown) ' +
      '— not what an earlier action was intended to accomplish.',
    parameters: [param('note', 'string', true, 'What was found')],
    handledByLoop: true,
  }),
  spec({
    name: 'finish',
    description: 'The goal is complete, or cannot be completed. Always end with this.',
    parameters: [param('summary', 'string', true, 'Outcome for the user')],
    handledByLoop: true,
  }),
]

// Mutable so tools can be added at runtime without editing the planner.
// `registerTool` is the only supported way in.
const REGISTRY = new Map<string, ToolSpec>(TOOL_SPECS.map((s) => [s.name, s]))

/**
 * Adds a tool to the registry. The planner needs no change: the tool is
 * documented in the prompt and validated on the way back from the same spec.
 * The runtime must still know how to execute the new tool.
 *
 * Deliberately not registered here: `terminal` and `email`. Handing shell
 * execution or outbound mail to an agent whose input includes attacker-
 * controlled page text converts a prompt injection into remote code
 * execution or spam relay. The mechanism supports them; the judgement is
 * that this application should not.
 */
export function registerTool(s: ToolSpec): void {
  if (REGISTRY.has(s.name)) {
    throw new Error(`Tool '${s.name}' is already registered.`)
  }
  REGISTRY.set(s.name, s)
}

/** Test-only escape hatch mirroring the Python tests' direct `_REGISTRY.pop(...)`. */
export function unregisterTool(name: string): void {
  REGISTRY.delete(name)
}

export function allTools(): readonly ToolSpec[] {
  return [...REGISTRY.values()]
}

export function requiresApproval(toolName: string): boolean {
  return REGISTRY.get(toolName)?.requiresApproval ?? false
}

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolSpec> = REGISTRY

/** The tool documentation block injected into the planner prompt. */
export function renderToolCatalogue(): string {
  const lines: string[] = []
  for (const s of allTools()) {
    const suffix = s.requiresApproval ? ' (the user must approve this before it runs)' : ''
    lines.push(`- ${s.name}: ${s.description}${suffix}`)
    lines.push(`  ${toolSignature(s)}`)
  }
  return lines.join('\n')
}

function validateNumber(name: string, value: unknown): number {
  if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolValidationError(`Argument '${name}' must be a number.`)
  }
  return value
}

function validateString(name: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolValidationError(`Argument '${name}' must be a non-empty string.`)
  }
  if (value.length > MAX_TEXT_ARGUMENT_LENGTH) {
    throw new ToolValidationError(`Argument '${name}' exceeds ${MAX_TEXT_ARGUMENT_LENGTH} characters.`)
  }
  return value
}

function validateUrl(name: string, value: unknown): string {
  const url = validateString(name, value)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ToolValidationError(`Argument '${name}' must be an absolute url with a host.`)
  }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    throw new ToolValidationError(
      `Argument '${name}' must be an http(s) url; got scheme '${parsed.protocol.replace(':', '') || 'none'}'.`,
    )
  }
  if (!parsed.host) {
    throw new ToolValidationError(`Argument '${name}' must be an absolute url with a host.`)
  }
  return url
}

function validateElementId(name: string, value: unknown, knownElementIds?: readonly string[]): string {
  const elementId = validateString(name, value)
  // A planner that invents an element id is hallucinating, and acting on a
  // made-up id would click whatever happens to occupy that slot.
  if (knownElementIds !== undefined && !knownElementIds.includes(elementId)) {
    throw new ToolValidationError(
      `Argument '${name}' references unknown element '${elementId}'. ` +
        'Only element ids present in the current page state may be used.',
    )
  }
  return elementId
}

/**
 * Tools whose sole required string argument can be auto-filled when the
 * planner omits it, rather than burning a planning-failure streak on a
 * pure formatting mistake. The fallback value is intentionally generic so
 * the working memory log still conveys something meaningful.
 *
 * ponytail: expand this map if new record-only tools are added.
 */
const ARGUMENT_FALLBACKS: Record<string, Record<string, string>> = {
  extract: { note: 'Recorded a finding from the current page.' },
  finish:  { summary: 'Goal completed.' },
}

/**
 * Validate a raw planner tool call. Returns [toolName, cleanedArguments].
 * Unknown arguments are rejected rather than dropped.
 */
export function validateToolCall(
  payload: unknown,
  knownElementIds?: readonly string[],
): [string, Record<string, unknown>] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ToolValidationError('Planner output must be a JSON object.')
  }
  const record = payload as Record<string, unknown>

  const toolName = record.tool
  if (typeof toolName !== 'string' || !TOOLS_BY_NAME.has(toolName)) {
    throw new ToolValidationError(
      `Unknown tool '${String(toolName)}'. Valid tools: ${[...TOOLS_BY_NAME.keys()].join(', ')}.`,
    )
  }

  const toolSpec = TOOLS_BY_NAME.get(toolName)!
  let rawArguments = record.arguments
  if (rawArguments === null || rawArguments === undefined) rawArguments = {}
  if (typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
    throw new ToolValidationError(`Arguments for '${toolName}' must be a JSON object.`)
  }
  const rawArgs = rawArguments as Record<string, unknown>

  const knownParameterNames = new Set(toolSpec.parameters.map((p) => p.name))
  const unexpected = Object.keys(rawArgs).filter((k) => !knownParameterNames.has(k)).sort()
  if (unexpected.length > 0) {
    throw new ToolValidationError(`Tool '${toolName}' does not accept argument(s): ${unexpected.join(', ')}.`)
  }

  const cleaned: Record<string, unknown> = {}
  for (const p of toolSpec.parameters) {
    if (!(p.name in rawArgs)) {
      if (p.required) {
        const fallback = ARGUMENT_FALLBACKS[toolName]?.[p.name]
        if (fallback !== undefined) {
          console.warn(`[planner] '${toolName}' missing required arg '${p.name}' — using fallback: "${fallback}"`)
          cleaned[p.name] = fallback
          continue
        }
        throw new ToolValidationError(`Tool '${toolName}' requires argument '${p.name}'.`)
      }
      continue
    }
    const value = rawArgs[p.name]
    if (p.kind === 'number') cleaned[p.name] = validateNumber(p.name, value)
    else if (p.kind === 'url') cleaned[p.name] = validateUrl(p.name, value)
    else if (p.kind === 'element_id') cleaned[p.name] = validateElementId(p.name, value, knownElementIds)
    else cleaned[p.name] = validateString(p.name, value)
  }

  return [toolName, cleaned]
}

// A queue exists to save planning round trips on obvious sequences, not to let
// the planner run unsupervised. Longer queues mean more actions between
// security scans.
export const MAX_QUEUE_LENGTH = 4

// Tools whose element ids come from the state the planner was given.
const ELEMENT_DEPENDENT = new Set(['click', 'fill', 'upload', 'scroll', 'evaluate', 'element_bounds', 'dispatch_mouse_event', 'drag', 'extract_virtual_table'])

/**
 * Validates a short action queue. Beyond per-call validation, the queue as a
 * whole must make sense:
 *  - Nothing may follow `finish`.
 *  - Nothing that targets an element may follow a `navigate` (element ids from
 *    the previous page are invalid on the new one).
 *  - A tool needing approval must be alone in the queue.
 */
export function validateToolQueue(
  payloads: unknown,
  knownElementIds?: readonly string[],
): Array<[string, Record<string, unknown>]> {
  if (!Array.isArray(payloads) || payloads.length === 0) {
    throw new ToolValidationError('Planner must return at least one tool call.')
  }
  if (payloads.length > MAX_QUEUE_LENGTH) {
    throw new ToolValidationError(`Planner returned more than ${MAX_QUEUE_LENGTH} queued actions.`)
  }

  const validated: Array<[string, Record<string, unknown>]> = []
  let navigated = false

  for (let index = 0; index < payloads.length; index++) {
    const [toolName, args] = validateToolCall(payloads[index], knownElementIds)

    if (index > 0 && ['evaluate', 'element_bounds', 'dispatch_mouse_event', 'drag', 'extract_virtual_table'].includes(validated[index - 1]![0])) {
      throw new ToolValidationError('Observe the previous tool result before planning dependent actions.')
    }

    if (index > 0 && validated[index - 1]![0] === 'finish') {
      throw new ToolValidationError("No action may follow 'finish'.")
    }

    if (navigated && ELEMENT_DEPENDENT.has(toolName)) {
      throw new ToolValidationError(
        `'${toolName}' cannot be queued after 'navigate': element ids from the ` +
          'previous page are invalid. Plan the next page in a separate step.',
      )
    }

    if (navigated && toolName === 'press_key') {
      throw new ToolValidationError(
        `'press_key' cannot be queued after 'navigate': wait for the new page to load and interact with an element first.`,
      )
    }

    if (index > 0) {
      const prevTool = validated[index - 1]![0]
      const prevArgs = validated[index - 1]![1]

      if ((prevTool === 'fill' || prevTool === 'type') && toolName === 'navigate') {
        throw new ToolValidationError(
          `'navigate' cannot immediately follow '${prevTool}': inputs must be submitted via 'press_key' (Enter) or a submit 'click' before navigating away.`,
        )
      }

      if (
        (prevTool === 'fill' || prevTool === 'type') &&
        (toolName === 'fill' || toolName === 'type') &&
        args.target &&
        args.target === prevArgs.target
      ) {
        throw new ToolValidationError(
          `Duplicate input on target '${args.target}' in the same queue. Combine inputs into a single step.`,
        )
      }
    }

    if (requiresApproval(toolName) && payloads.length > 1) {
      throw new ToolValidationError(`'${toolName}' needs user approval and must be planned on its own, not queued.`)
    }

    if (toolName === 'navigate') navigated = true

    validated.push([toolName, args])
  }

  return validated
}
