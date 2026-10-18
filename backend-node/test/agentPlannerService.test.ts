// Port of backend/app/tests/test_agent_planner_service.py — planner reply
// parsing, confidence handling, and prompt shape. No network: parsePlan and
// buildMessages are pure.
import { describe, expect, it } from 'vitest'
import { agentPlannerService } from '../src/services/agentPlannerService.js'
import { ToolValidationError } from '../src/services/agentToolRegistry.js'
import type { AgentPageState, AgentWorkingMemory } from '../src/schemas/agent.schemas.js'

const KNOWN_IDS = ['e1', 'e2']

describe('JSON parsing', () => {
  it('plain JSON is parsed', () => {
    const [actions, confidence, reason] = agentPlannerService.parsePlan(
      '{"tool": "click", "arguments": {"target": "e1"}, "confidence": 0.9, "reason": "the login button"}',
      KNOWN_IDS,
    )
    expect(actions).toEqual([['click', { target: 'e1' }]])
    expect(confidence).toBe(0.9)
    expect(reason).toBe('the login button')
  })

  it('JSON wrapped in a markdown fence is parsed', () => {
    const [actions] = agentPlannerService.parsePlan('```json\n{"tool": "wait", "confidence": 0.5}\n```', KNOWN_IDS)
    expect(actions[0]![0]).toBe('wait')
  })

  it('JSON surrounded by prose is parsed', () => {
    const [actions] = agentPlannerService.parsePlan(
      'Sure! Here is the next step:\n{"tool": "finish", "arguments": {"summary": "done"}}\nHope that helps.',
      KNOWN_IDS,
    )
    expect(actions).toEqual([['finish', { summary: 'done' }]])
  })

  it('braces inside string values do not end the scan', () => {
    const [actions] = agentPlannerService.parsePlan(
      '{"tool": "type", "arguments": {"text": "a } brace { inside"}, "confidence": 0.8}',
      KNOWN_IDS,
    )
    expect(actions[0]![0]).toBe('type')
    expect(actions[0]![1].text).toBe('a } brace { inside')
  })

  it('escaped quotes inside a string are handled', () => {
    const [actions] = agentPlannerService.parsePlan('{"tool": "type", "arguments": {"text": "say \\"hi\\""}}', KNOWN_IDS)
    expect(actions[0]![1].text).toBe('say "hi"')
  })

  it('an empty response is rejected', () => {
    expect(() => agentPlannerService.parsePlan('', KNOWN_IDS)).toThrow(/empty response/)
  })

  it('a response without JSON is rejected', () => {
    expect(() => agentPlannerService.parsePlan('I cannot help with that.', KNOWN_IDS)).toThrow(/no JSON object/)
  })

  it('unterminated JSON is rejected', () => {
    expect(() => agentPlannerService.parsePlan('{"tool": "click", "arguments": {', KNOWN_IDS)).toThrow(/unterminated/)
  })

  it('malformed JSON is rejected', () => {
    expect(() => agentPlannerService.parsePlan('{"tool": "click",,}', KNOWN_IDS)).toThrow(/not valid JSON/)
  })
})

describe('confidence', () => {
  it('missing confidence defaults to the midpoint', () => {
    const [, confidence] = agentPlannerService.parsePlan('{"tool": "wait"}', KNOWN_IDS)
    expect(confidence).toBe(0.5)
  })

  it.each([
    ['5', 1.0],
    ['-2', 0.0],
    ['"high"', 0.5],
    ['true', 0.5],
  ])('confidence %s clamps/type-checks to %s', (rawValue, expected) => {
    const [, confidence] = agentPlannerService.parsePlan(`{"tool": "wait", "confidence": ${rawValue}}`, KNOWN_IDS)
    expect(confidence).toBe(expected)
  })

  it('a hallucinated element id fails validation through the planner', () => {
    expect(() => agentPlannerService.parsePlan('{"tool": "click", "arguments": {"target": "e42"}}', KNOWN_IDS)).toThrow(
      /unknown element/,
    )
  })
})

function sampleState(): AgentPageState {
  return {
    url: 'https://shop.test/cart',
    title: 'Cart',
    elements: [
      { id: 'e1', role: 'textbox', name: 'Coupon', required: true },
      { id: 'e2', role: 'button', name: 'Apply', disabled: true },
    ],
    focusedElementId: 'e1',
    dialogs: [{ id: 'e3', role: 'dialog', name: 'Cookies', modal: true }],
  }
}

describe('prompt shape', () => {
  it('the prompt carries goal, memory, and state only', () => {
    const memory: AgentWorkingMemory = {
      goal: 'apply a coupon',
      completed_steps: [{ tool: 'navigate', summary: 'opened cart', succeeded: true }],
      failures: [{ tool: 'click', reason: 'element gone', code: 'ELEMENT_NOT_FOUND' }],
      retries: 1,
    }
    const messages = agentPlannerService.buildMessages('apply a coupon', memory, sampleState())
    expect(messages.map((m) => m.role)).toEqual(['system', 'user'])

    const userPrompt = messages[1]!.content
    expect(userPrompt).toContain('apply a coupon')
    expect(userPrompt).toContain('opened cart')
    expect(userPrompt).toContain('ELEMENT_NOT_FOUND')
    expect(userPrompt).toContain('e1 [textbox] "Coupon"')
    expect(userPrompt).toContain('e2 [button] "Apply"')
    expect(userPrompt).toContain('disabled')
    expect(userPrompt).toContain('modal dialog')
  })

  it('page content is fenced as untrusted, after the goal', () => {
    const messages = agentPlannerService.buildMessages('x', { goal: 'x' }, sampleState())
    const userPrompt = messages[1]!.content
    expect(userPrompt).toContain('BEGIN UNTRUSTED PAGE CONTENT')
    expect(userPrompt).toContain('END UNTRUSTED PAGE CONTENT')
    expect(userPrompt.indexOf('GOAL:')).toBeLessThan(userPrompt.indexOf('BEGIN UNTRUSTED PAGE CONTENT'))
  })

  it('the system prompt documents every tool and the injection rule', () => {
    const messages = agentPlannerService.buildMessages('x', { goal: 'x' }, sampleState())
    const systemPrompt = messages[0]!.content
    for (const name of ['click', 'fill', 'navigate', 'finish']) {
      expect(systemPrompt).toContain(`- ${name}:`)
    }
    expect(systemPrompt).toContain('CRITICAL SECURITY RULE')
    expect(systemPrompt).not.toContain('{tool_catalogue}')
  })

  it('empty memory renders a first-step marker', () => {
    const messages = agentPlannerService.buildMessages('x', { goal: 'x' }, sampleState())
    expect(messages[1]!.content).toContain('this is the first step')
  })

  it('the system prompt includes the search and input guidelines', () => {
    const messages = agentPlannerService.buildMessages('search for grok bot', { goal: 'search' }, sampleState())
    const systemPrompt = messages[0]!.content
    expect(systemPrompt).toContain('PAGE INTERACTION')
    expect(systemPrompt).toContain('Fill the editable searchbox/textbox before submitting')
    expect(systemPrompt).toContain('press_key')
  })
})

describe('attaching downloaded files', () => {
  const stateWithDownloads = (): AgentPageState => ({
    ...sampleState(),
    downloads: [{ id: 'd1', filename: 'Leave application.pdf', sizeBytes: 28_262 }],
    fileChooser: { multiple: false },
  })

  it('lists the session downloads and an open file chooser in the page state', () => {
    const userPrompt = agentPlannerService.buildMessages('x', { goal: 'x' }, stateWithDownloads())[1]!.content
    expect(userPrompt).toContain('DOWNLOADS')
    expect(userPrompt).toContain('d1 "Leave application.pdf" 27.6 KB')
    expect(userPrompt).toContain('FILE CHOOSER OPEN: the page is waiting for one file')
  })

  it('omits both sections when there is nothing to attach', () => {
    const userPrompt = agentPlannerService.buildMessages('x', { goal: 'x' }, sampleState())[1]!.content
    expect(userPrompt).not.toContain('DOWNLOADS (')
    expect(userPrompt).not.toContain('FILE CHOOSER OPEN')
  })

  it('accepts an upload of a listed download and rejects an invented one', () => {
    const [actions] = agentPlannerService.parsePlan(
      '{"tool": "upload", "arguments": {"target": "e1", "download": "d1"}}', KNOWN_IDS, ['d1'],
    )
    expect(actions).toEqual([['upload', { target: 'e1', download: 'd1' }]])
    expect(() =>
      agentPlannerService.parsePlan('{"tool": "upload", "arguments": {"target": "e1", "download": "d3"}}', KNOWN_IDS, ['d1']),
    ).toThrow(/unknown download 'd3'/)
  })

  it('tells the planner to let upload open the file dialog itself', () => {
    const systemPrompt = agentPlannerService.buildMessages('x', { goal: 'x' }, sampleState())[0]!.content
    expect(systemPrompt).toContain('Attaching a file: call upload')
    expect(systemPrompt).toContain('download=<id>')
  })
})

describe('session memory', () => {
  it('parses the progress checklist, normalising statuses', () => {
    const [, , , , progress] = agentPlannerService.parsePlan(
      '{"progress":[{"step":"Open Google Docs","status":"done"},{"step":"Type letter","status":"in progress"},' +
        '{"step":"Download","status":"completed"},"Verify file",{"nope":1}],"actions":[{"tool":"wait","arguments":{}}]}',
      KNOWN_IDS,
    )
    expect(progress).toEqual([
      { step: 'Open Google Docs', status: 'done' },
      { step: 'Type letter', status: 'in_progress' },
      { step: 'Download', status: 'done' },
      { step: 'Verify file', status: 'todo' },
    ])
  })

  it('a missing or malformed checklist does not reject the plan', () => {
    const [actions, , , , progress] = agentPlannerService.parsePlan('{"progress":"soon","tool":"wait"}', KNOWN_IDS)
    expect(actions).toHaveLength(1)
    expect(progress).toBeUndefined()
  })

  it('renders progress, milestones, entered content and prior tasks ahead of the step log', () => {
    const memory: AgentWorkingMemory = {
      goal: 'write a letter',
      step_number: 7,
      completed_steps: [{ tool: 'click', summary: 'clicked File', succeeded: true, step: 7 }],
      plan_progress: [
        { step: 'Create blank document', status: 'done' },
        { step: 'Type the application', status: 'done' },
        { step: 'Download as .docx', status: 'in_progress' },
      ],
      milestones: ['[step 3] Opened https://docs.google.com/document/create'],
      content_entered: [
        {
          step: 5,
          tool: 'type',
          page: 'https://docs.google.com/document/d/abc/edit',
          chars: 1200,
          head: 'To: The Registrar, Alhamd Islamic University',
          tail: '…Yours sincerely, [Student Name]',
          status: 'unverifiable',
        },
      ],
      session_history: [
        { goal: 'open gmail', status: 'completed', outcome: 'Gmail opened', milestones: [], finalUrl: 'https://mail.google.com/' },
      ],
    }
    const userPrompt = agentPlannerService.buildMessages('write a letter', memory, sampleState())[1]!.content

    expect(userPrompt).toContain('STEP 8')
    expect(userPrompt).toContain('[in_progress] Download as .docx')
    expect(userPrompt).toContain('Opened https://docs.google.com/document/create')
    expect(userPrompt).toContain('CONTENT ALREADY ENTERED')
    expect(userPrompt).toContain('To: The Registrar, Alhamd Islamic University')
    expect(userPrompt).toContain('editor hides its content')
    expect(userPrompt).toContain('PREVIOUS TASKS IN THIS SESSION')
    expect(userPrompt).not.toContain('this is the first step')
    expect(userPrompt.indexOf('CONTENT ALREADY ENTERED')).toBeLessThan(userPrompt.indexOf('recent actions:'))
  })

  it('the system prompt tells the planner not to re-type entered content', () => {
    const systemPrompt = agentPlannerService.buildMessages('x', { goal: 'x' }, sampleState())[0]!.content
    expect(systemPrompt).toContain('SESSION MEMORY')
    expect(systemPrompt).toContain('NEVER type, re-type, rewrite')
    expect(systemPrompt).toContain('"progress"')
  })
})

it('the planner singleton is exported and functional', () => {
  expect(typeof agentPlannerService.parsePlan).toBe('function')
  expect(() => agentPlannerService.parsePlan('nope', KNOWN_IDS)).toThrow(ToolValidationError)
})
