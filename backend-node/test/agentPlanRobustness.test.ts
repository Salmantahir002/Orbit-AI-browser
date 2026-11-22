// What real models write, and what the planner now does with it: spelling
// slips are normalised, a queue keeps its valid prefix, an unusable reply gets
// one in-request repair, and provider failures are classified. None of it may
// widen what the agent can do — those cases are asserted here too.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { AgentPlannerService, agentPlannerService } from '../src/services/agentPlannerService.js'
import { normalizeElementId, normalizeToolQueue } from '../src/services/agentPlanNormalizer.js'
import { ToolValidationError, renderToolCatalogue, validateToolQueue } from '../src/services/agentToolRegistry.js'
import { PlannerProviderError, llmProviderManager } from '../src/services/llmProviderManager.js'

const IDS = ['e1', 'e2', 'e3', 'e12']
const STATE = {
  url: 'https://shop.test/checkout',
  title: 'Checkout',
  elements: [
    { id: 'e1', role: 'combobox', name: 'Country' },
    { id: 'e2', role: 'textbox', name: 'City' },
    { id: 'e3', role: 'button', name: 'Continue' },
    { id: 'e12', role: 'link', name: 'Menu' },
  ],
}

function tools(raw: unknown[]) {
  return normalizeToolQueue(raw, IDS).actions.map(([tool, args]) => [tool, args])
}

describe('spelling normalisation', () => {
  it('maps tool-name aliases onto registered tools', () => {
    expect(tools([{ tool: 'goto', arguments: { url: 'https://example.com' } }])).toEqual([['navigate', { url: 'https://example.com' }]])
    expect(tools([{ tool: 'Click_Element', arguments: { target: 'e3' } }])).toEqual([['click', { target: 'e3' }]])
    expect(tools([{ tool: 'done', arguments: { answer: 'It costs $5' } }])).toEqual([['finish', { summary: 'It costs $5' }]])
    expect(tools([{ tool: 'back' }])).toEqual([['go_back', {}]])
  })

  it('normalises element ids, argument names and argument placement', () => {
    expect(normalizeElementId(12)).toBe('e12')
    expect(normalizeElementId('[e12]')).toBe('e12')
    expect(normalizeElementId('#E3')).toBe('e3')
    expect(tools([{ tool: 'click', element: 12 }])).toEqual([['click', { target: 'e12' }]])
    expect(tools([{ name: 'fill', args: { element_id: '2', text: 'Lahore' } }])).toEqual([['fill', { target: 'e2', value: 'Lahore' }]])
    expect(tools([{ function: { name: 'click', arguments: '{"target":"e3"}' } }])).toEqual([['click', { target: 'e3' }]])
  })

  it('turns a type aimed at an element into click + type, never into a field-clearing fill', () => {
    expect(tools([{ tool: 'type', arguments: { target: 'e2', text: 'hello' } }])).toEqual([
      ['click', { target: 'e2' }],
      ['type', { text: 'hello' }],
    ])
  })

  it('understands scroll directions, key lists and bare hosts', () => {
    expect(tools([{ tool: 'scroll_down' }])).toEqual([['scroll', { deltaY: 600 }]])
    expect(tools([{ tool: 'scroll', arguments: { direction: 'up', amount: '300' } }])).toEqual([['scroll', { deltaY: -300 }]])
    expect(tools([{ tool: 'press_key', arguments: { keys: ['Control', 'm'] } }])).toEqual([['press_key', { key: 'Control+m' }]])
    expect(tools([{ tool: 'navigate', arguments: { url: 'youtube.com/results?search_query=x' } }])).toEqual([
      ['navigate', { url: 'https://youtube.com/results?search_query=x' }],
    ])
  })

  it('drops arguments no tool documents instead of rejecting the plan', () => {
    const { actions, notes } = normalizeToolQueue([{ tool: 'click', arguments: { target: 'e3', force: true } }], IDS)
    expect(actions).toEqual([['click', { target: 'e3' }]])
    expect(notes.join(' ')).toContain('force')
  })

  it('never widens what the planner may do', () => {
    expect(() => normalizeToolQueue([{ tool: 'shell', arguments: { command: 'rm -rf /' } }], IDS)).toThrow(/Unknown tool 'shell'/)
    expect(() => normalizeToolQueue([{ tool: 'goto', arguments: { url: 'file:///C:/secrets.txt' } }], IDS)).toThrow(/http\(s\) url/)
    expect(() => normalizeToolQueue([{ tool: 'navigate', arguments: { url: 'javascript:alert(1)' } }], IDS)).toThrow(ToolValidationError)
    expect(() => normalizeToolQueue([{ tool: 'click', arguments: { target: 'e99' } }], IDS)).toThrow(/unknown element 'e99'/)
    // A file path smuggled into upload is dropped; the user still picks the file.
    expect(tools([{ tool: 'upload', arguments: { target: 'e3', path: 'C:/Users/me/id.pdf' } }])).toEqual([['upload', { target: 'e3' }]])
  })
})

describe('queue salvage', () => {
  it('keeps the valid prefix and drops the rest', () => {
    const { actions, notes } = normalizeToolQueue([
      { tool: 'fill', arguments: { target: 'e2', value: 'Lahore' } },
      { tool: 'click', arguments: { target: 'e3' } },
      { tool: 'click', arguments: { target: 'e77' } },
      { tool: 'finish', arguments: { summary: 'x' } },
    ], IDS)
    expect(actions.map(([tool]) => tool)).toEqual(['fill', 'click'])
    expect(notes.join(' ')).toContain("unknown element 'e77'")
  })

  it('cuts an over-long queue to the limit', () => {
    const queue = Array.from({ length: 7 }, () => ({ tool: 'scroll', arguments: { deltaY: 100 } }))
    expect(normalizeToolQueue(queue, IDS).actions).toHaveLength(4)
  })

  it('still rejects a plan whose first action is wrong', () => {
    expect(() => normalizeToolQueue([{ tool: 'click', arguments: { target: 'e77' } }, { tool: 'click', arguments: { target: 'e3' } }], IDS))
      .toThrow(/unknown element 'e77'/)
  })

  it('the strict validator itself is unchanged', () => {
    expect(() => validateToolQueue([
      { tool: 'navigate', arguments: { url: 'https://a.test' } },
      { tool: 'click', arguments: { target: 'e1' } },
    ], IDS)).toThrow(/cannot be queued after 'navigate'/)
  })
})

describe('reply extraction', () => {
  it('skips reasoning blocks full of braces', () => {
    const raw = '<think>The page has {lots} of {braces} and maybe {"tool":"finish"}</think>\n{"actions":[{"tool":"click","arguments":{"target":"e3"}}]}'
    expect(agentPlannerService.parsePlan(raw, IDS)[0]).toEqual([['click', { target: 'e3' }]])
  })

  it('prefers the object that is a plan over an example before it', () => {
    const raw = 'Element format is {"id": "e1"}. My plan: {"actions":[{"tool":"click","arguments":{"target":"e3"}}]}'
    expect(agentPlannerService.parsePlan(raw, IDS)[0]).toEqual([['click', { target: 'e3' }]])
  })

  it('tolerates trailing commas', () => {
    expect(AgentPlannerService.extractJsonObject('{"actions":[{"tool":"go_back",},],}')).toEqual({ actions: [{ tool: 'go_back' }] })
  })

  it('accepts other action-list keys', () => {
    expect(agentPlannerService.parsePlan('{"tool_calls":[{"name":"click","arguments":{"target":"e3"}}]}', IDS)[0]).toEqual([['click', { target: 'e3' }]])
  })
})

describe('new tools', () => {
  it('are documented', () => {
    const catalogue = renderToolCatalogue()
    for (const name of ['select_option', 'hover', 'go_back', 'ask_user']) expect(catalogue).toContain(`- ${name}:`)
  })

  it('ask_user ends its queue; go_back ends element use like navigate', () => {
    expect(() => validateToolQueue([{ tool: 'ask_user', arguments: { question: 'Sign in please' } }, { tool: 'click', arguments: { target: 'e3' } }], IDS))
      .toThrow(/No action may follow 'ask_user'/)
    expect(() => validateToolQueue([{ tool: 'go_back' }, { tool: 'click', arguments: { target: 'e3' } }], IDS)).toThrow(/go_back/)
    expect(validateToolQueue([{ tool: 'select_option', arguments: { target: 'e1', option: 'Pakistan' } }, { tool: 'click', arguments: { target: 'e3' } }], IDS))
      .toHaveLength(2)
  })
})

describe('provider failures', () => {
  it('are classified, with the key masked', () => {
    const key = 'AIzaSyD-example-key-1234567890'
    const auth = PlannerProviderError.from(new Error(`Authentication failed (401): bad key ${key}`), [key])
    expect(auth.kind).toBe('auth')
    expect(auth.message).not.toContain(key)
    expect(PlannerProviderError.from(new Error('Gemini API error (429): RESOURCE_EXHAUSTED')).kind).toBe('rate_limit')
    expect(PlannerProviderError.from(new Error('Network error connecting to X: ECONNRESET')).kind).toBe('provider')
    expect(PlannerProviderError.from(new Error('unreachable https://x.test/v1?key=abcdef123456')).message).toContain('key=***')
  })
})

describe('POST /agent/plan robustness', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const body = { goal: 'checkout', working_memory: { goal: 'checkout' }, page_state: STATE }

  it('repairs an invalid reply in the same request', async () => {
    vi.spyOn(agentPlannerService, 'isConfigured', 'get').mockReturnValue(true)
    const chat = vi.spyOn(llmProviderManager, 'planChat')
      .mockResolvedValueOnce('{"actions":[{"tool":"click","arguments":{"target":"e99"}}]}')
      .mockResolvedValueOnce('{"actions":[{"tool":"click","arguments":{"target":"e3"}}],"confidence":0.9}')
    const res = await app.inject({ method: 'POST', url: '/api/v1/agent/plan', payload: body })
    expect(res.statusCode).toBe(200)
    expect(res.json().tool_calls[0]).toMatchObject({ tool: 'click', arguments: { target: 'e3' } })
    const repairTurn = chat.mock.calls[1]![0].messages
    expect(repairTurn.at(-2)).toMatchObject({ role: 'assistant' })
    expect(repairTurn.at(-1)!.content).toContain("unknown element 'e99'")
  })

  it('gives up after one repair', async () => {
    vi.spyOn(agentPlannerService, 'isConfigured', 'get').mockReturnValue(true)
    const chat = vi.spyOn(llmProviderManager, 'planChat').mockResolvedValue('no idea')
    const res = await app.inject({ method: 'POST', url: '/api/v1/agent/plan', payload: body })
    expect(res.statusCode).toBe(422)
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('maps a rejected key to 503 and a rate limit to 429', async () => {
    vi.spyOn(agentPlannerService, 'isConfigured', 'get').mockReturnValue(true)
    vi.spyOn(llmProviderManager, 'planChat').mockRejectedValueOnce(new PlannerProviderError('auth', 'The AI provider rejected the API key: (401)'))
    expect((await app.inject({ method: 'POST', url: '/api/v1/agent/plan', payload: body })).statusCode).toBe(503)
    vi.spyOn(llmProviderManager, 'planChat').mockRejectedValueOnce(new PlannerProviderError('rate_limit', 'The AI provider is rate-limiting requests'))
    expect((await app.inject({ method: 'POST', url: '/api/v1/agent/plan', payload: body })).statusCode).toBe(429)
  })
})

describe('popups in the planner prompt', () => {
  it('lists open popups with their close buttons, inside the page block', () => {
    const prompt = agentPlannerService.buildMessages('make a sheet', { goal: 'make a sheet' }, {
      ...STATE,
      popups: [
        { role: 'dialog', name: 'Save time with tables', closeButtons: [{ id: 'e3', name: 'Got it', auto: true }] },
        { role: 'complementary', name: 'Tables', closeButtons: [{ id: 'e12', name: 'Close', auto: false }] },
      ],
    })[1]!.content
    expect(prompt).toContain('POPUPS OPEN')
    expect(prompt).toContain('[dialog] "Save time with tables" — close with e3 "Got it"')
    expect(prompt).toContain('[complementary] "Tables" — close with e12 "Close"')
    expect(prompt.indexOf('POPUPS OPEN')).toBeGreaterThan(prompt.indexOf('BEGIN UNTRUSTED PAGE CONTENT'))
  })

  it('tells the planner and the reviewer to leave no unneeded popup open', () => {
    const system = agentPlannerService.buildMessages('x', { goal: 'x' }, STATE)[0]!.content
    expect(system).toContain('POPUPS OPEN lists onboarding tips')
  })
})
