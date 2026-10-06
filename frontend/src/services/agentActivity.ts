import type { AgentToolCall } from '../types/agentTypes'

/** User-facing intent, kept separate from protocol names and executable code. */
export function describeAgentActivity(call: AgentToolCall): string {
  const args = call.arguments ?? {}
  if (call.tool === 'evaluate') {
    if (typeof args.description === 'string' && args.description.trim()) {
      return args.description.replace(/\s+/g, ' ').trim().slice(0, 160)
    }
    const expression = String(args.expression ?? '')
    if (/aria-sort|sortModel/i.test(expression)) return 'Checking the table’s sort order'
    if (/getBoundingClientRect|offsetWidth|clientWidth/.test(expression)) return 'Measuring element positions'
    if (/row-index|row-id|gridcell|ag-row/.test(expression)) return 'Reading the currently rendered table rows'
    if (/columnheader|ag-header|col-id/.test(expression)) return 'Inspecting table columns'
    if (/scrollTop|scrollHeight/.test(expression)) return 'Checking the scroll position'
    if (/input|placeholder|searchbox/i.test(expression)) return 'Inspecting search fields and filters'
    return 'Inspecting the page’s current content'
  }
  const labels: Record<Exclude<AgentToolCall['tool'], 'evaluate'>, string> = {
    element_bounds: 'Locating an element on the page',
    dispatch_mouse_event: args.type === 'mouseWheel' ? 'Scrolling to reveal more content' : 'Moving the pointer on the page',
    drag: 'Dragging the selected element',
    extract_virtual_table: 'Collecting table rows and checking for duplicates',
    click: 'Selecting a page control', fill: 'Filling in a field', type: 'Entering text',
    press_key: 'Pressing a key', navigate: 'Opening the requested page', open_tab: 'Opening a new tab',
    scroll: 'Scrolling the page', upload: 'Attaching the selected files', wait: 'Waiting for the page to settle',
    extract: 'Recording the findings', finish: 'Preparing the result',
  }
  return labels[call.tool]
}
