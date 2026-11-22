// App playbooks: proven procedures for web apps whose editing surface is not
// in the accessibility tree (Google Slides draws slides as SVG, Docs and
// Sheets draw on a canvas). Without them a planner has to discover, mid-task
// and from an element list that does not show the slide, how text gets onto a
// slide at all. That is where multi-step creation goals fell apart.
//
// A playbook is selected by the page the agent is on or by what the goal asks
// for. It is guidance written by us, not page content, so it sits outside the
// untrusted page block in the prompt.

export interface AppPlaybook {
  id: string
  title: string
  /** True when the playbook applies to this goal on this page. */
  matches: (goal: string, url: string) => boolean
  steps: readonly string[]
}

const OTHER_PRESENTATION_APPS = /\b(canva|powerpoint online|office\.com|sway|prezi|pitch\.com|keynote|gamma)\b/i
const OTHER_DOCUMENT_APPS = /\b(word online|office\.com|notion|dropbox paper|zoho)\b/i

const PLAYBOOKS: readonly AppPlaybook[] = [
  {
    id: 'google-slides',
    title: 'GOOGLE SLIDES (docs.google.com/presentation)',
    matches: (goal, url) =>
      /docs\.google\.com\/presentation/i.test(url) ||
      /google\s*slides?/i.test(goal) ||
      (/\b(presentation|slides?|slide\s*deck|deck|ppt)\b/i.test(goal) && !OTHER_PRESENTATION_APPS.test(goal)),
    steps: [
      'New deck: navigate to https://docs.google.com/presentation/create (opens a new blank presentation with a title slide). If a Google sign-in page appears instead, call ask_user to let the user sign in, then continue; never type passwords.',
      'A new deck may open a "Themes" side panel and tip popups: close them (their Close / "Got it" buttons, listed under POPUPS OPEN) before editing, and leave none open at the end.',
      'Rename: fill the title box at the top left (value "Untitled presentation", often named "Rename") with the deck title, then press_key Enter.',
      'Slide text lives on an SVG canvas, not in the element list. Empty placeholders show the prompts "Click to add title", "Click to add subtitle" and "Click to add text". To write into one: click_text that prompt, then type its whole content in ONE type call (\\n between bullet lines). Clicking the next placeholder ends editing of the previous one.',
      'Slide 1 uses the title layout: click_text "Click to add title" -> type the deck title; click_text "Click to add subtitle" -> type a subtitle.',
      'Add every further slide with press_key "Control+m" (or click the "New slide" toolbar button). The new slide becomes the current slide with the "Title and body" layout: click_text "Click to add title" -> type the slide title; click_text "Click to add text" -> type 3-5 bullet lines.',
      'Make exactly the requested number of slides; never leave an extra empty slide. Keep one progress sub-goal per slide and mark it done only after its title AND body were typed.',
      'If a prompt such as "Click to add title" is not found, that placeholder already holds text or another slide is selected: call read_text to see the current slide before anything else. Never retype text listed under CONTENT ALREADY ENTERED.',
      'Before finishing, call read_text: its DRAWN TEXT section lists the text of every slide (editor and filmstrip thumbnails), so you can confirm the slide count and each slide\'s content. Slides saves automatically.',
    ],
  },
  {
    id: 'google-docs',
    title: 'GOOGLE DOCS (docs.google.com/document)',
    matches: (goal, url) =>
      /docs\.google\.com\/document/i.test(url) ||
      /google\s*docs?\b/i.test(goal) ||
      (/\bgoogle\b/i.test(goal) && /\b(document|letter|essay|report|article|notes)\b/i.test(goal) && !OTHER_DOCUMENT_APPS.test(goal)),
    steps: [
      'New document: navigate to https://docs.google.com/document/create. If a Google sign-in page appears instead, call ask_user to let the user sign in, then continue; never type passwords.',
      'A new document may show tip popups or a side panel: close them (listed under POPUPS OPEN) before typing, and leave none open at the end.',
      'Rename: fill the title box at the top left (value "Untitled document", often named "Rename") with the title, then press_key Enter.',
      'The page body is drawn on a canvas, so typed text does not appear in the element list. A new document already has the cursor in the body; after renaming, click the document body area (or press_key Escape) to return to it before typing.',
      'Type the whole document in ONE type call with \\n line breaks. Formatting shortcuts: Control+b bold, Control+i italic, Control+Alt+1 / Control+Alt+2 heading levels, Control+Shift+8 bulleted list, Control+Shift+7 numbered list.',
      'Docs saves automatically. To export, use the File menu > Download and choose the requested format.',
    ],
  },
  {
    id: 'google-sheets',
    title: 'GOOGLE SHEETS (docs.google.com/spreadsheets)',
    matches: (goal, url) =>
      /docs\.google\.com\/spreadsheets/i.test(url) ||
      /google\s*sheets?\b/i.test(goal) ||
      (/\bspreadsheet\b/i.test(goal) && !/\bexcel\b/i.test(goal)),
    steps: [
      'New spreadsheet: navigate to https://docs.google.com/spreadsheets/create. If a Google sign-in page appears instead, call ask_user to let the user sign in, then continue.',
      'A new spreadsheet may show tip popups (e.g. "Save time with tables" with a "Got it" button) or a side panel such as "Tables": close them (listed under POPUPS OPEN) before entering data, and leave none open at the end.',
      'Rename: fill the title box at the top left (value "Untitled spreadsheet") with the title, then press_key Enter.',
      'Go to a cell: fill the "Name Box" combobox with its address (e.g. A1) and press_key Enter.',
      'Enter a whole table in ONE type call starting at the top-left cell: \\t moves to the next cell to the right and \\n to the start of the next row, e.g. "Name\\tAge\\nAli\\t22\\n". Formulas are typed as text starting with =.',
      'The grid is a canvas: cell values are not in the element list. Check a cell by selecting it (Name Box) and reading the formula bar, or with read_text.',
    ],
  },
]

/** Playbooks that apply to this goal on this page, rendered for the prompt. */
export function renderPlaybooks(goal: string, url: string): string {
  const selected = PLAYBOOKS.filter((playbook) => playbook.matches(goal, url ?? ''))
  if (selected.length === 0) return ''
  return selected
    .map((playbook) => [playbook.title, ...playbook.steps.map((step) => `  - ${step}`)].join('\n'))
    .join('\n')
}

export function playbookIds(goal: string, url: string): string[] {
  return PLAYBOOKS.filter((playbook) => playbook.matches(goal, url ?? '')).map((playbook) => playbook.id)
}
