// Analyse → act → verify: the task brief, the self-check, the new tools that
// creation tasks in SVG/canvas apps (Google Slides) depend on, and the app
// playbooks that tell the planner how those apps work.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { agentPlannerService } from '../src/services/agentPlannerService.js'
import { agentReviewService } from '../src/services/agentReviewService.js'
import { llmProviderManager } from '../src/services/llmProviderManager.js'
import { playbookIds, renderPlaybooks } from '../src/services/agentPlaybooks.js'
import {
  ToolValidationError,
  renderToolCatalogue,
  validateKeyCombo,
  validateToolCall,
  validateToolQueue,
} from '../src/services/agentToolRegistry.js'

const PREFIX = '/api/v1'
const SLIDES_GOAL = 'Create a presentation on global warming in Google Slides with 5 slides'
const SLIDES_URL = 'https://docs.google.com/presentation/d/abc123/edit#slide=id.p'

const SLIDES_STATE = {
  url: SLIDES_URL,
  title: 'Global Warming - Google Slides',
  elements: [
    { id: 'e1', role: 'textbox', name: 'Rename', value: 'Global Warming' },
    { id: 'e2', role: 'button', name: 'New slide (Ctrl+M)' },
  ],
}

describe('press_key shortcuts', () => {
  it('accepts single keys and app shortcuts', () => {
    for (const key of ['Enter', 'Escape', 'a', '+', 'Control+m', 'Control+Shift+8', 'Ctrl+b', 'Control+Enter', 'Control+Alt+1', 'Shift+Tab', 'Control+Shift+7']) {
      expect(validateKeyCombo('key', key)).toBe(key)
    }
  })

  it('refuses browser shortcuts that would act on Orbit itself', () => {
    for (const key of ['Control+w', 'Control+t', 'Control+n', 'Control+l', 'Control+p', 'Control+Tab', 'Control+0', 'Control+-', 'Alt+f', 'Control+Shift+b', 'Meta+w', 'Control++']) {
      expect(() => validateKeyCombo('key', key), key).toThrow(/browser shortcut/)
    }
  })

  it('keeps page shortcuts that only look like browser ones', () => {
    // Ctrl+B is bold in every editor; only Ctrl+Shift+B toggles the bookmarks bar.
    expect(validateKeyCombo('key', 'Control+b')).toBe('Control+b')
    expect(validateKeyCombo('key', 'Control+Shift+h')).toBe('Control+Shift+h')
  })

  it('explains malformed shortcuts', () => {
    expect(() => validateKeyCombo('key', 'Hyper+m')).toThrow(/unknown modifier/)
    expect(() => validateKeyCombo('key', 'Control+F5')).toThrow(/unsupported key/)
  })

  it('is applied when validating a press_key call', () => {
    expect(validateToolCall({ tool: 'press_key', arguments: { key: 'Control+m' } })).toEqual(['press_key', { key: 'Control+m' }])
    expect(() => validateToolCall({ tool: 'press_key', arguments: { key: 'Control+w' } })).toThrow(ToolValidationError)
  })
})

describe('click_text, read_text and finish status', () => {
  it('are documented for the planner', () => {
    const catalogue = renderToolCatalogue()
    expect(catalogue).toContain('click_text')
    expect(catalogue).toContain('Click to add title')
    expect(catalogue).toContain('read_text')
    expect(catalogue).toContain('"blocked"')
  })

  it('click_text can be followed by type in one queue', () => {
    const queue = validateToolQueue([
      { tool: 'click_text', arguments: { text: 'Click to add title' } },
      { tool: 'type', arguments: { text: 'Global Warming' } },
      { tool: 'click_text', arguments: { text: 'Click to add subtitle' } },
      { tool: 'type', arguments: { text: 'Causes, effects and solutions' } },
    ])
    expect(queue.map(([tool]) => tool)).toEqual(['click_text', 'type', 'click_text', 'type'])
  })

  it('read_text is an observation and must end its queue', () => {
    expect(() => validateToolQueue([
      { tool: 'read_text', arguments: {} },
      { tool: 'finish', arguments: { summary: 'done' } },
    ])).toThrow(/Observe the previous tool result/)
  })

  it('click_text cannot follow navigate', () => {
    expect(() => validateToolQueue([
      { tool: 'navigate', arguments: { url: 'https://docs.google.com/presentation/create' } },
      { tool: 'click_text', arguments: { text: 'Click to add title' } },
    ])).toThrow(/cannot be queued after 'navigate'/)
  })

  it('normalises the finish status', () => {
    expect(validateToolCall({ tool: 'finish', arguments: { summary: 'x', status: 'blocked' } })[1].status).toBe('blocked')
    expect(validateToolCall({ tool: 'finish', arguments: { summary: 'x', status: 'Cannot complete: sign-in' } })[1].status).toBe('blocked')
    expect(validateToolCall({ tool: 'finish', arguments: { summary: 'x', status: 'success' } })[1].status).toBe('done')
    expect(validateToolCall({ tool: 'finish', arguments: { summary: 'x' } })[1]).toEqual({ summary: 'x' })
  })
})

describe('app playbooks', () => {
  it('selects Google Slides for a presentation goal, before any page is open', () => {
    expect(playbookIds(SLIDES_GOAL, 'about:blank')).toEqual(['google-slides'])
    expect(playbookIds('make a 5 slide deck about AI', '')).toEqual(['google-slides'])
    expect(renderPlaybooks(SLIDES_GOAL, '')).toContain('https://docs.google.com/presentation/create')
  })

  it('selects by the page the agent is on', () => {
    expect(playbookIds('add a slide about solar power', SLIDES_URL)).toEqual(['google-slides'])
    expect(playbookIds('fix the typo in the second paragraph', 'https://docs.google.com/document/d/x/edit')).toEqual(['google-docs'])
    expect(playbookIds('put totals in column C', 'https://docs.google.com/spreadsheets/d/x/edit')).toEqual(['google-sheets'])
  })

  it('stays out of the way for other apps and unrelated goals', () => {
    expect(playbookIds('make a presentation in Canva', 'https://www.canva.com/')).toEqual([])
    expect(playbookIds('search for flights to Lahore', 'https://www.google.com/')).toEqual([])
  })
})

describe('planner prompt', () => {
  it('carries the playbook, the brief and a refused self-check', () => {
    const messages = agentPlannerService.buildMessages(SLIDES_GOAL, {
      goal: SLIDES_GOAL,
      task_brief: {
        summary: 'A 5-slide Google Slides deck on global warming',
        requirements: ['Exactly 5 slides', 'Every slide has a title and body text'],
        content: 'Slide 1 — Title: Global Warming\nSubtitle: Causes, effects, solutions',
      },
      self_check: { attempt: 1, missing: ['Only 4 slides exist'], next_step: 'press_key Control+m and fill slide 5' },
    }, SLIDES_STATE)
    const prompt = messages[1]!.content
    expect(messages[0]!.content).toContain('ANALYSE, ACT, VERIFY')
    expect(prompt).toContain('APP PLAYBOOK')
    expect(prompt).toContain('Click to add title')
    expect(prompt).toContain('TASK BRIEF')
    expect(prompt).toContain('1. Exactly 5 slides')
    expect(prompt).toContain('    Subtitle: Causes, effects, solutions')
    expect(prompt).toContain('SELF-CHECK REJECTED YOUR FINISH (attempt 1)')
    expect(prompt).toContain('Only 4 slides exist')
    // The playbook is operator guidance, so it sits before the untrusted page block.
    expect(prompt.indexOf('APP PLAYBOOK')).toBeLessThan(prompt.indexOf('BEGIN UNTRUSTED PAGE CONTENT'))
  })

  it('keeps only the newest observations in full', () => {
    const old = `{"tool":"read_text","result":"${'x'.repeat(2000)}"}`
    const messages = agentPlannerService.buildMessages('goal', {
      goal: 'goal',
      extracted_knowledge: [old, 'a', 'b', `recent ${'y'.repeat(2000)}`],
    }, SLIDES_STATE)
    const prompt = messages[1]!.content
    expect(prompt).toContain('y'.repeat(2000))
    expect(prompt).not.toContain('x'.repeat(2000))
    expect(prompt).toContain('… [truncated]')
  })
})

describe('task analysis parsing', () => {
  it('builds a brief from the model reply', () => {
    const brief = agentReviewService.parseAnalysis(JSON.stringify({
      summary: '5-slide deck on global warming',
      task_type: 'content_creation',
      requirements: ['Exactly 5 slides', 'Each slide has a title and body'],
      plan: ['Create a new deck', 'Slide 1', 'Slide 2'],
      content: 'Slide 1 — Title: Global Warming',
      start_url: 'https://docs.google.com/presentation/create',
      risks: ['Typing into the wrong placeholder'],
    }), SLIDES_GOAL)
    expect(brief.requirements).toEqual(['Exactly 5 slides', 'Each slide has a title and body'])
    expect(brief.plan).toHaveLength(3)
    expect(brief.start_url).toBe('https://docs.google.com/presentation/create')
  })

  it('drops a non-http start url and accepts prose around the JSON', () => {
    const brief = agentReviewService.parseAnalysis(
      'Here is the brief:\n```json\n{"summary":"s","requirements":["r"],"start_url":"javascript:alert(1)"}\n```',
      'goal',
    )
    expect(brief.start_url).toBeUndefined()
    expect(brief.requirements).toEqual(['r'])
  })

  it('refuses a brief with no requirements', () => {
    expect(() => agentReviewService.parseAnalysis('{"summary":"s","requirements":[]}', 'goal')).toThrow(ToolValidationError)
  })
})

describe('self-check verdicts', () => {
  it('passes only when every check is met', () => {
    const verdict = agentReviewService.parseVerdict(JSON.stringify({
      complete: true,
      checks: [
        { requirement: 'Exactly 5 slides', met: true, evidence: 'DRAWN TEXT lists 5 slides' },
        { requirement: 'Topic is global warming', met: true, evidence: 'titles mention global warming' },
      ],
      missing: [],
      confidence: 0.9,
    }))
    expect(verdict.complete).toBe(true)
    expect(verdict.missing).toEqual([])
  })

  it('does not trust "complete: true" when a check failed', () => {
    const verdict = agentReviewService.parseVerdict(JSON.stringify({
      complete: true,
      checks: [
        { requirement: 'Exactly 5 slides', met: false, evidence: 'only 4 slides in the filmstrip' },
        { requirement: 'Topic is global warming', met: true, evidence: '' },
      ],
      next_step: 'Add slide 5',
    }))
    expect(verdict.complete).toBe(false)
    expect(verdict.missing).toEqual(['Exactly 5 slides'])
    expect(verdict.next_step).toBe('Add slide 5')
  })

  it('always says what is missing when it refuses', () => {
    const verdict = agentReviewService.parseVerdict('{"complete": false}')
    expect(verdict.complete).toBe(false)
    expect(verdict.missing.length).toBeGreaterThan(0)
  })

  it('puts the page text inside the untrusted block and leaves out its own last verdict', () => {
    const messages = agentReviewService.buildVerificationMessages(
      SLIDES_GOAL,
      'Created 5 slides',
      { goal: SLIDES_GOAL, self_check: { attempt: 1, missing: ['old gap'] } },
      SLIDES_STATE,
      'DRAWN TEXT (SVG, one line per drawing/slide):\n1. Global Warming',
    )
    const prompt = messages[1]!.content
    expect(prompt.indexOf('PAGE TEXT')).toBeGreaterThan(prompt.indexOf('BEGIN UNTRUSTED PAGE CONTENT'))
    expect(prompt.indexOf('PAGE TEXT')).toBeLessThan(prompt.indexOf('END UNTRUSTED PAGE CONTENT'))
    expect(prompt).not.toContain('old gap')
  })
})

describe('POST /agent/analyze and /agent/verify', () => {
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

  function configure(reply: string) {
    vi.spyOn(agentPlannerService, 'isConfigured', 'get').mockReturnValue(true)
    return vi.spyOn(llmProviderManager, 'planChat').mockResolvedValue(reply)
  }

  it('analyse returns a brief and the matching playbooks', async () => {
    const chat = configure('{"summary":"deck","requirements":["Exactly 5 slides"],"plan":["Create deck"],"content":"Slide 1 — Title: Global Warming"}')
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/agent/analyze`,
      payload: { goal: SLIDES_GOAL, page_state: { url: 'about:blank', title: '' } },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.brief.requirements).toEqual(['Exactly 5 slides'])
    expect(body.brief.content).toContain('Global Warming')
    expect(body.playbooks).toEqual(['google-slides'])
    expect(chat.mock.calls[0]![0].messages[1]!.content).toContain('APP PLAYBOOK')
  })

  it('analyse reports an unusable reply as 422', async () => {
    configure('I cannot help with that.')
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/agent/analyze`, payload: { goal: SLIDES_GOAL } })
    expect(res.statusCode).toBe(422)
  })

  it('both are unavailable without a provider', async () => {
    vi.spyOn(agentPlannerService, 'isConfigured', 'get').mockReturnValue(false)
    const analyse = await app.inject({ method: 'POST', url: `${PREFIX}/agent/analyze`, payload: { goal: 'x' } })
    const verify = await app.inject({ method: 'POST', url: `${PREFIX}/agent/verify`, payload: { goal: 'x' } })
    expect(analyse.statusCode).toBe(503)
    expect(verify.statusCode).toBe(503)
  })

  it('verify returns the verdict with what is missing', async () => {
    configure('{"complete":false,"checks":[{"requirement":"Exactly 5 slides","met":false,"evidence":"4 slides"}],"missing":["Slide 5"],"next_step":"Add slide 5","confidence":0.8}')
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/agent/verify`,
      payload: {
        goal: SLIDES_GOAL,
        claimed_summary: 'Done',
        working_memory: { goal: SLIDES_GOAL, task_brief: { summary: 's', requirements: ['Exactly 5 slides'] } },
        page_state: SLIDES_STATE,
        page_text: '1. Global Warming',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.complete).toBe(false)
    expect(body.missing).toContain('Slide 5')
    expect(body.next_step).toBe('Add slide 5')
  })

  it('verify reports a provider failure as 502', async () => {
    vi.spyOn(agentPlannerService, 'isConfigured', 'get').mockReturnValue(true)
    vi.spyOn(llmProviderManager, 'planChat').mockRejectedValue(new Error('boom'))
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/agent/verify`, payload: { goal: 'x' } })
    expect(res.statusCode).toBe(502)
  })
})
