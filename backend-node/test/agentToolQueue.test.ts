// Port of backend/app/tests/test_agent_tool_queue.py — multi-step action
// queues, the extensible tool registry, and the 3 end-to-end tests that mock
// the planner's LLM call (added in Phase 4 with /agent/plan).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { agentPlannerService } from '../src/services/agentPlannerService.js'
import {
  MAX_QUEUE_LENGTH,
  ToolValidationError,
  allTools,
  registerTool,
  renderToolCatalogue,
  requiresApproval,
  unregisterTool,
  validateToolQueue,
} from '../src/services/agentToolRegistry.js'

const KNOWN_IDS = ['e1', 'e2', 'e3']

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () => {
  await app.close()
})

describe('queue validation', () => {
  it('a single-action queue is accepted', () => {
    expect(validateToolQueue([{ tool: 'click', arguments: { target: 'e1' } }], KNOWN_IDS)).toEqual([
      ['click', { target: 'e1' }],
    ])
  })

  it('a valid sequence is accepted', () => {
    const actions = validateToolQueue(
      [
        { tool: 'fill', arguments: { target: 'e1', value: 'shoes' } },
        { tool: 'press_key', arguments: { key: 'Enter' } },
      ],
      KNOWN_IDS,
    )
    expect(actions.map(([name]) => name)).toEqual(['fill', 'press_key'])
  })

  it('an empty queue is rejected', () => {
    expect(() => validateToolQueue([], KNOWN_IDS)).toThrow(/at least one/)
  })

  it('an overlong queue is rejected', () => {
    const payload = Array.from({ length: MAX_QUEUE_LENGTH + 1 }, () => ({ tool: 'wait' }))
    expect(() => validateToolQueue(payload, KNOWN_IDS)).toThrow(/more than/)
  })

  it("nothing may follow 'finish'", () => {
    expect(() =>
      validateToolQueue(
        [
          { tool: 'finish', arguments: { summary: 'done' } },
          { tool: 'click', arguments: { target: 'e1' } },
        ],
        KNOWN_IDS,
      ),
    ).toThrow(/follow 'finish'/)
  })

  it('an element action cannot be queued after navigate', () => {
    expect(() =>
      validateToolQueue(
        [
          { tool: 'navigate', arguments: { url: 'https://example.test' } },
          { tool: 'click', arguments: { target: 'e1' } },
        ],
        KNOWN_IDS,
      ),
    ).toThrow(/cannot be queued after 'navigate'/)
  })

  it('a non-element action may follow navigate', () => {
    const actions = validateToolQueue(
      [{ tool: 'navigate', arguments: { url: 'https://example.test' } }, { tool: 'wait' }],
      KNOWN_IDS,
    )
    expect(actions.map(([name]) => name)).toEqual(['navigate', 'wait'])
  })

  it('an approval tool may not be hidden inside a queue', () => {
    expect(() =>
      validateToolQueue(
        [
          { tool: 'click', arguments: { target: 'e1' } },
          { tool: 'upload', arguments: { target: 'e2' } },
        ],
        KNOWN_IDS,
      ),
    ).toThrow(/must be planned on its own/)
  })

  it('an invalid action rejects the whole queue', () => {
    expect(() =>
      validateToolQueue(
        [
          { tool: 'click', arguments: { target: 'e1' } },
          { tool: 'click', arguments: { target: 'e99' } },
        ],
        KNOWN_IDS,
      ),
    ).toThrow(ToolValidationError)
  })

  it('rejects navigate immediately following fill or type', () => {
    expect(() =>
      validateToolQueue(
        [
          { tool: 'fill', arguments: { target: 'e1', value: 'query' } },
          { tool: 'navigate', arguments: { url: 'https://example.test' } },
        ],
        KNOWN_IDS,
      ),
    ).toThrow(/cannot immediately follow 'fill'/)

    expect(() =>
      validateToolQueue(
        [
          { tool: 'type', arguments: { text: 'query' } },
          { tool: 'navigate', arguments: { url: 'https://example.test' } },
        ],
        KNOWN_IDS,
      ),
    ).toThrow(/cannot immediately follow 'type'/)
  })

  it('rejects duplicate input on the same target in one queue', () => {
    expect(() =>
      validateToolQueue(
        [
          { tool: 'fill', arguments: { target: 'e1', value: 'first' } },
          { tool: 'fill', arguments: { target: 'e1', value: 'second' } },
        ],
        KNOWN_IDS,
      ),
    ).toThrow(/Duplicate input on target 'e1'/)
  })

  it('rejects press_key immediately after navigate', () => {
    expect(() =>
      validateToolQueue(
        [
          { tool: 'navigate', arguments: { url: 'https://example.test' } },
          { tool: 'press_key', arguments: { key: 'Enter' } },
        ],
        KNOWN_IDS,
      ),
    ).toThrow(/'press_key' cannot be queued after 'navigate'/)
  })
})

describe('registry', () => {
  it('upload requires approval and click does not', () => {
    expect(requiresApproval('upload')).toBe(true)
    expect(requiresApproval('click')).toBe(false)
    expect(requiresApproval('nonexistent')).toBe(false)
  })

  it('dangerous tools are not registered', () => {
    const names = new Set(allTools().map((s) => s.name))
    expect(names.has('terminal')).toBe(false)
    expect(names.has('email')).toBe(false)
    expect(names.has('shell')).toBe(false)
  })

  it('a new tool appears in the prompt without touching the planner', async () => {
    registerTool({
      name: 'test_only_clipboard',
      description: 'Copy text to the clipboard.',
      parameters: [{ name: 'text', kind: 'string', required: true, description: 'Text to copy' }],
      category: 'clipboard',
      requiresApproval: false,
      handledByLoop: false,
    })
    try {
      expect(renderToolCatalogue()).toContain('- test_only_clipboard:')
      const actions = validateToolQueue([{ tool: 'test_only_clipboard', arguments: { text: 'hi' } }], KNOWN_IDS)
      expect(actions).toEqual([['test_only_clipboard', { text: 'hi' }]])

      const res = await app.inject({ method: 'GET', url: '/api/v1/agent/tools' })
      const names = new Set((res.json() as Array<{ name: string }>).map((t) => t.name))
      expect(names.has('test_only_clipboard')).toBe(true)
    } finally {
      unregisterTool('test_only_clipboard')
    }
  })

  it('a duplicate registration is refused', () => {
    expect(() => registerTool({ name: 'click', description: 'dupe', parameters: [], category: 'browser', requiresApproval: false, handledByLoop: false })).toThrow(
      /already registered/,
    )
  })

  it('the /agent/tools endpoint exposes approval metadata', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/agent/tools' })
    const tools = Object.fromEntries((res.json() as Array<{ name: string }>).map((t) => [t.name, t]))
    expect(tools.upload.requires_approval).toBe(true)
    expect(tools.upload.category).toBe('files')
    expect(tools.finish.handled_by_loop).toBe(true)
  })
})

describe('planner endpoint (end to end)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function planBody() {
    return {
      goal: 'search',
      working_memory: { goal: 'search' },
      page_state: {
        url: 'https://x.test',
        title: 'X',
        elements: [{ id: 'e1', role: 'searchbox', name: 'Search' }],
        dialogs: [],
        validationErrors: [],
        selectedElementIds: [],
        truncated: false,
      },
    }
  }

  function stubPlanner(reply: string) {
    vi.spyOn(agentPlannerService, 'isConfigured', 'get').mockReturnValue(true)
    vi.spyOn(agentPlannerService as unknown as { callModel: () => Promise<string> }, 'callModel').mockResolvedValue(reply)
  }

  it('a queue is returned through the endpoint', async () => {
    stubPlanner(
      '{"actions": [{"tool": "fill", "arguments": {"target": "e1", "value": "shoes"}},' +
        ' {"tool": "press_key", "arguments": {"key": "Enter"}}], "confidence": 0.9}',
    )
    const body = (await app.inject({ method: 'POST', url: '/api/v1/agent/plan', payload: planBody() })).json()
    expect((body.tool_calls as Array<{ tool: string }>).map((c) => c.tool)).toEqual(['fill', 'press_key'])
    expect(body.tool_call.tool).toBe('fill')
  })

  it('a click queued after navigate is dropped; the navigate still runs', async () => {
    // The click's element id belongs to the old page, so it must never run.
    // The navigate before it is valid on its own and is kept (queue salvage).
    stubPlanner(
      '{"actions": [{"tool": "navigate", "arguments": {"url": "https://evil.test"}},' +
        ' {"tool": "click", "arguments": {"target": "e1"}}], "confidence": 1.0}',
    )
    const res = await app.inject({ method: 'POST', url: '/api/v1/agent/plan', payload: planBody() })
    expect(res.statusCode).toBe(200)
    expect(res.json().tool_calls.map((call: { tool: string }) => call.tool)).toEqual(['navigate'])
  })

  it('upload is flagged for approval through the endpoint', async () => {
    stubPlanner('{"actions": [{"tool": "upload", "arguments": {"target": "e1"}}], "confidence": 0.9}')
    const body = (await app.inject({ method: 'POST', url: '/api/v1/agent/plan', payload: planBody() })).json()
    expect(body.tool_calls[0].requires_approval).toBe(true)
  })
})
