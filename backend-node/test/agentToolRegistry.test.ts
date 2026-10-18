// Port of backend/app/tests/test_agent_tool_registry.py.
import { describe, expect, it } from 'vitest'
import {
  TOOLS_BY_NAME,
  ToolValidationError,
  renderToolCatalogue,
  validateToolCall,
} from '../src/services/agentToolRegistry.js'

const KNOWN_IDS = ['e1', 'e2', 'e3']

it('a valid click is accepted', () => {
  const [tool, args] = validateToolCall({ tool: 'click', arguments: { target: 'e2' } }, KNOWN_IDS)
  expect(tool).toBe('click')
  expect(args).toEqual({ target: 'e2' })
})

it('a valid fill is accepted', () => {
  const [tool, args] = validateToolCall({ tool: 'fill', arguments: { target: 'e1', value: 'hello' } }, KNOWN_IDS)
  expect(tool).toBe('fill')
  expect(args).toEqual({ target: 'e1', value: 'hello' })
})

it('a tool with no arguments is accepted', () => {
  const [tool, args] = validateToolCall({ tool: 'wait' }, KNOWN_IDS)
  expect(tool).toBe('wait')
  expect(args).toEqual({})
})

it('an unknown tool is rejected', () => {
  expect(() => validateToolCall({ tool: 'execute_shell', arguments: {} }, KNOWN_IDS)).toThrow(/Unknown tool/)
})

it('a missing required argument is rejected', () => {
  expect(() => validateToolCall({ tool: 'click', arguments: {} }, KNOWN_IDS)).toThrow(/requires argument 'target'/)
})

it('an unexpected argument is rejected', () => {
  expect(() =>
    validateToolCall({ tool: 'click', arguments: { target: 'e1', force: true } }, KNOWN_IDS),
  ).toThrow(/does not accept argument/)
})

it('a hallucinated element id is rejected', () => {
  expect(() => validateToolCall({ tool: 'click', arguments: { target: 'e99' } }, KNOWN_IDS)).toThrow(/unknown element 'e99'/)
})

describe('dangerous navigation schemes', () => {
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>x</script>', '/relative/path'])(
    '%s is rejected',
    (url) => {
      expect(() => validateToolCall({ tool: 'navigate', arguments: { url } }, KNOWN_IDS)).toThrow(ToolValidationError)
    },
  )
})

it('https navigation is accepted', () => {
  const [tool, args] = validateToolCall({ tool: 'navigate', arguments: { url: 'https://example.com/x' } }, KNOWN_IDS)
  expect(tool).toBe('navigate')
  expect(args.url).toBe('https://example.com/x')
})

it('a number argument rejects a string', () => {
  expect(() => validateToolCall({ tool: 'scroll', arguments: { deltaY: 'down' } }, KNOWN_IDS)).toThrow(/must be a number/)
})

it('a boolean is not accepted as a number', () => {
  expect(() => validateToolCall({ tool: 'scroll', arguments: { deltaY: true } }, KNOWN_IDS)).toThrow(/must be a number/)
})

it('an empty string argument is rejected', () => {
  expect(() => validateToolCall({ tool: 'type', arguments: { text: '   ' } }, KNOWN_IDS)).toThrow(/non-empty string/)
})

it('oversized text is rejected', () => {
  expect(() => validateToolCall({ tool: 'type', arguments: { text: 'x'.repeat(6000) } }, KNOWN_IDS)).toThrow(/exceeds/)
})

it('a non-object payload is rejected', () => {
  expect(() => validateToolCall(['click'], KNOWN_IDS)).toThrow(/must be a JSON object/)
})

it('an optional element id is still validated when present', () => {
  expect(() => validateToolCall({ tool: 'scroll', arguments: { target: 'e77' } }, KNOWN_IDS)).toThrow(/unknown element/)
})

it('scroll without a target is accepted', () => {
  const [tool, args] = validateToolCall({ tool: 'scroll', arguments: { deltaY: 400 } }, KNOWN_IDS)
  expect(tool).toBe('scroll')
  expect(args).toEqual({ deltaY: 400 })
})

it('the catalogue documents every registered tool', () => {
  const catalogue = renderToolCatalogue()
  for (const name of TOOLS_BY_NAME.keys()) {
    expect(catalogue).toContain(`- ${name}:`)
  }
})

describe('upload from this session\'s downloads', () => {
  const KNOWN_DOWNLOADS = ['d1', 'd2']

  it('accepts a listed download id', () => {
    const [tool, args] = validateToolCall({ tool: 'upload', arguments: { target: 'e1', download: 'd2' } }, KNOWN_IDS, KNOWN_DOWNLOADS)
    expect(tool).toBe('upload')
    expect(args).toEqual({ target: 'e1', download: 'd2' })
  })

  it('still accepts an upload where the user picks the file', () => {
    const [, args] = validateToolCall({ tool: 'upload', arguments: { target: 'e1' } }, KNOWN_IDS, KNOWN_DOWNLOADS)
    expect(args).toEqual({ target: 'e1' })
  })

  it('rejects a download id that is not in the page state', () => {
    expect(() =>
      validateToolCall({ tool: 'upload', arguments: { target: 'e1', download: 'd9' } }, KNOWN_IDS, KNOWN_DOWNLOADS),
    ).toThrow(/unknown download 'd9'/)
  })

  it('rejects any download id when the session has no downloads', () => {
    expect(() =>
      validateToolCall({ tool: 'upload', arguments: { target: 'e1', download: 'd1' } }, KNOWN_IDS, []),
    ).toThrow(/unknown download 'd1'/)
  })

  it('rejects a file path smuggled in as the download id', () => {
    expect(() =>
      validateToolCall({ tool: 'upload', arguments: { target: 'e1', download: 'C:\Users\me\secrets.txt' } }, KNOWN_IDS, KNOWN_DOWNLOADS),
    ).toThrow(ToolValidationError)
  })

  it('documents the download argument in the tool catalogue', () => {
    expect(renderToolCatalogue()).toContain('"download": <download_id?>')
  })
})
