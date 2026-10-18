import { _electron as electron, test, expect, type ElectronApplication, type Page, type Route } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Agent mode attaching a file it downloaded earlier in the session.
 *
 * The case this covers: the agent exports a PDF from Google Docs, then opens
 * Gmail and clicks the paperclip. Gmail's file input is hidden; the paperclip
 * calls `input.click()`, and Chromium answers with the OS "Open" dialog, which
 * the agent cannot operate. While the agent holds the tab that dialog must be
 * intercepted, and the file must come from the browser's own Downloads list —
 * never from a path the planner made up.
 *
 * Everything runs over the real CDP path against a local server, so the
 * download is a real download and the attached file is read back by the page.
 */

const PDF_BYTES = Buffer.from('%PDF-1.4\n% Leave application\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
const PDF_NAME = 'leave-application.pdf'
const OLD_NAME = 'last-week-report.pdf'

const DOWNLOAD_PAGE = `<!doctype html><html><head><title>Docs export</title></head><body>
  <h1>Leave application</h1>
  <a href="/files/${PDF_NAME}">Download as PDF</a>
</body></html>`

/** Gmail's shape: a paperclip button driving a hidden, freshly created file input. */
const COMPOSE_PAGE = `<!doctype html><html><head><title>Compose</title></head><body>
  <h1>New Message</h1>
  <button id="attach" aria-label="Attach files">📎</button>
  <p id="attached"></p>
  <script>
    document.getElementById('attach').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const file = input.files[0];
        const head = new TextDecoder().decode((await file.arrayBuffer()).slice(0, 5));
        document.getElementById('attached').textContent = file.name + '|' + file.size + '|' + head;
      });
      document.body.appendChild(input);
      input.click();
    });
  </script>
</body></html>`

type RuntimeResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }
type PageState = {
  url: string
  elements: { id: string; role: string; name: string }[]
  downloads?: { id: string; filename: string; sizeBytes: number }[]
  fileChooser?: { multiple: boolean } | null
}

test.describe.serial('Agent upload from session downloads', () => {
  let app: ElectronApplication
  let shell: Page
  let server: Server
  let origin: string
  let downloadsFolder: string

  test.beforeAll(async () => {
    const info = test.info()
    const profile = info.outputPath('browser-profile')
    downloadsFolder = info.outputPath('downloads')
    await mkdir(downloadsFolder, { recursive: true })
    await mkdir(profile, { recursive: true })

    // A completed download from an earlier run of the app. It is in the
    // Downloads panel, and its file is on disk, but it is not this session's.
    const oldFile = path.join(downloadsFolder, OLD_NAME)
    await writeFile(oldFile, PDF_BYTES)
    await writeFile(path.join(profile, 'browser-profile.json'), JSON.stringify({
      history: [], bookmarks: [], bookmarkMigrationComplete: true,
      settings: { downloadFolder: downloadsFolder, askWhereToSave: false },
      downloads: [{
        id: 'earlier-session', filename: OLD_NAME, url: 'https://example.test/report.pdf', savePath: oldFile,
        startedAt: Date.now() - 86_400_000, receivedBytes: PDF_BYTES.length, totalBytes: PDF_BYTES.length,
        bytesPerSecond: 0, state: 'completed', paused: false, canResume: false,
      }],
    }))

    server = createServer((request, response) => {
      if (request.url === `/files/${PDF_NAME}`) {
        response.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${PDF_NAME}"`,
          'Content-Length': PDF_BYTES.length,
        })
        response.end(PDF_BYTES)
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(request.url === '/compose' ? COMPOSE_PAGE : DOWNLOAD_PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local server failed to start')
    origin = `http://127.0.0.1:${address.port}`

    const env = Object.fromEntries(Object.entries({ ...process.env, PROMPT_DEFENSE_DEV: 'false', ORBIT_USER_DATA_DIR: profile })
      .filter((entry): entry is [string, string] => entry[1] !== undefined))
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ args: [path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist-electron/main.js')], env })
    shell = await app.firstWindow()
    await shell.locator('.start-button').click()
    await expect(shell.locator('.browser-frame')).toBeVisible()
    await expect.poll(() => shell.locator('.browser-webview[data-webcontents-id]').count()).toBe(1)
  })

  test.afterAll(async () => {
    await app?.close()
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  async function activeTargetId(): Promise<number> {
    return await shell.evaluate(() => Number((document.querySelector('.browser-webview[data-webcontents-id]') as HTMLElement).dataset.webcontentsId))
  }

  async function invoke<T>(targetId: number, name: string, params: Record<string, unknown> = {}) {
    return await shell.evaluate(
      ([id, command, args]) => window.electronAPI!.runtimeInvoke({ targetId: id as number, name: command as string, params: args as Record<string, unknown> }) as Promise<unknown>,
      [targetId, name, params] as const,
    ) as RuntimeResult<T>
  }

  async function open(pathname: string): Promise<number> {
    const targetId = await activeTargetId()
    const url = `${origin}${pathname}`
    await shell.evaluate(([id, href]) => window.electronAPI!.browser.navigate(id as number, href as string), [targetId, url] as const)
    await expect.poll(async () => {
      const described = await invoke<{ url: string }>(targetId, 'describeTarget')
      return described.ok && described.data.url === url
    }, { timeout: 20_000 }).toBe(true)
    // Let the document finish parsing so the accessibility tree has the controls.
    await expect.poll(async () => (await state(targetId)).elements.length, { timeout: 10_000 }).toBeGreaterThan(0)
    return targetId
  }

  async function state(targetId: number): Promise<PageState> {
    const result = await invoke<PageState>(targetId, 'extractPageState')
    if (!result.ok) throw new Error(`extractPageState failed: ${result.error.message}`)
    return result.data
  }

  /** True when serialised page state mentions the downloads folder in any form. */
  function leaksFolder(value: unknown): boolean {
    const json = JSON.stringify(value)
    return json.includes(JSON.stringify(downloadsFolder).slice(1, -1)) || json.includes(downloadsFolder)
  }

  function elementNamed(snapshot: PageState, name: string): string {
    const element = snapshot.elements.find((candidate) => candidate.name === name)
    if (!element) throw new Error(`No "${name}" element in ${JSON.stringify(snapshot.elements)}`)
    return element.id
  }

  function downloadNamed(snapshot: PageState, filename: string): string {
    const download = snapshot.downloads?.find((candidate) => candidate.filename === filename)
    if (!download) throw new Error(`No "${filename}" in downloads ${JSON.stringify(snapshot.downloads)}`)
    return download.id
  }

  async function attachedText(targetId: number): Promise<string> {
    return await app.evaluate(
      ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('document.getElementById("attached").textContent'),
      targetId,
    ) as string
  }

  async function setAgentLock(targetId: number, locked: boolean) {
    expect(await shell.evaluate(([id, value]) => window.electronAPI!.browser.setAgentLock(id as number, value as boolean), [targetId, locked] as const)).toBe(true)
  }

  test('a file the agent downloads appears in its page state, by id and without its path', async () => {
    let targetId = await open('/download')
    expect((await state(targetId)).downloads ?? []).toEqual([])

    const link = elementNamed(await state(targetId), 'Download as PDF')
    expect((await invoke(targetId, 'click', { elementId: link })).ok).toBe(true)

    await expect.poll(async () => (await state(targetId)).downloads?.map((download) => download.filename), { timeout: 20_000 }).toEqual([PDF_NAME])
    // The download panel pops open on a new download; it is browser chrome, not the page.
    await shell.evaluate(() => window.electronAPI!.browserUI.close())

    targetId = await open('/compose')
    const snapshot = await state(targetId)
    expect(snapshot.downloads).toEqual([{ id: 'd1', filename: PDF_NAME, sizeBytes: PDF_BYTES.length }])
    expect(leaksFolder(snapshot)).toBe(false)
    // The earlier session's download is in the panel but never offered to the agent.
    const panel = await shell.evaluate(async () => (await window.electronAPI!.browserUI.snapshot()).downloads.map((entry) => entry.filename))
    expect(panel).toContain(OLD_NAME)
    expect(JSON.stringify(snapshot)).not.toContain(OLD_NAME)
  })

  test('an Attach click during an agent task is intercepted instead of opening the OS dialog', async () => {
    const targetId = await open('/compose')
    await setAgentLock(targetId, true)
    try {
      const before = await state(targetId)
      expect(before.fileChooser).toBeNull()

      expect((await invoke(targetId, 'click', { elementId: elementNamed(before, 'Attach files') })).ok).toBe(true)

      // The page asked for files; with the OS dialog intercepted, the agent sees that instead.
      const waiting = await state(targetId)
      expect(waiting.fileChooser).toEqual({ multiple: true })

      const uploaded = await invoke<{ verification: { reason: string } }>(targetId, 'upload', {
        elementId: elementNamed(waiting, 'Attach files'),
        downloadId: downloadNamed(waiting, PDF_NAME),
      })
      expect(uploaded.ok, JSON.stringify(uploaded)).toBe(true)
      if (uploaded.ok) expect(uploaded.data.verification.reason).toContain(PDF_NAME)

      // The page read the real file: its name, its size and the PDF magic bytes.
      await expect.poll(() => attachedText(targetId)).toBe(`${PDF_NAME}|${PDF_BYTES.length}|%PDF-`)
      expect((await state(targetId)).fileChooser).toBeNull()
    } finally {
      await setAgentLock(targetId, false)
    }
  })

  test('upload opens the chooser itself when given the Attach button', async () => {
    // No agent lock: upload switches interception on just for its own click.
    const targetId = await open('/compose')
    const snapshot = await state(targetId)

    const uploaded = await invoke(targetId, 'upload', {
      elementId: elementNamed(snapshot, 'Attach files'),
      downloadId: downloadNamed(snapshot, PDF_NAME),
    })
    expect(uploaded.ok, JSON.stringify(uploaded)).toBe(true)
    await expect.poll(() => attachedText(targetId)).toBe(`${PDF_NAME}|${PDF_BYTES.length}|%PDF-`)
  })

  test('an unknown download id is refused before anything is clicked', async () => {
    const targetId = await open('/compose')
    await setAgentLock(targetId, true)
    try {
      const snapshot = await state(targetId)
      const refused = await invoke(targetId, 'upload', { elementId: elementNamed(snapshot, 'Attach files'), downloadId: 'd7' })
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.error.code).toBe('ELEMENT_NOT_FOUND')

      // Had the button been clicked, the intercepted chooser would show here.
      expect((await state(targetId)).fileChooser).toBeNull()
      expect(await attachedText(targetId)).toBe('')
    } finally {
      await setAgentLock(targetId, false)
    }
  })

  test('agent mode attaches the downloaded PDF end to end after the user approves it', async () => {
    const targetId = await open('/compose')
    const plannedStates: PageState[] = []

    // Stands in for the LLM planner: attach the downloaded PDF, then finish.
    await shell.route('**/api/v1/agent/plan', async (route: Route) => {
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' }
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })

      const pageState = (route.request().postDataJSON() as { page_state: PageState }).page_state
      plannedStates.push(pageState)
      const toolCall = plannedStates.length === 1
        ? {
            tool: 'upload',
            arguments: { target: elementNamed(pageState, 'Attach files'), download: downloadNamed(pageState, PDF_NAME) },
            requires_approval: true,
          }
        : { tool: 'finish', arguments: { summary: `Attached ${PDF_NAME} to the email.` } }
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({
          tool_calls: [toolCall], tool_call: toolCall, confidence: 0.95, needs_user_confirmation: false,
          reason: plannedStates.length === 1 ? 'Attach the downloaded leave application' : 'Done', model: 'stub', planner_mode: 'llm',
        }),
      })
    })

    try {
      await shell.locator('.assistant-pill').click()
      const panel = shell.locator('[aria-label="Kimo panel"]')
      await panel.locator('.assistant-mode-tab', { hasText: 'Agent' }).click()
      await panel.locator('.agent-goal-input').fill('Attach the leave application PDF I downloaded to this email')
      await panel.locator('.agent-run-button').click()

      // The user is told exactly which file is going where before it happens.
      const approval = panel.getByRole('alertdialog', { name: 'Approval required' })
      await expect(approval).toBeVisible({ timeout: 20_000 })
      await expect(approval.locator('.agent-approval-summary')).toContainText(`Attach "${PDF_NAME}"`)
      await expect(approval.locator('.agent-approval-summary')).toContainText('127.0.0.1')
      await approval.getByRole('button', { name: 'Allow', exact: true }).click()

      await expect(panel.locator('.agent-result')).toContainText('Done', { timeout: 20_000 })
      await expect(panel.locator('.agent-result')).toContainText(`Attached ${PDF_NAME}`)
      await expect.poll(() => attachedText(targetId)).toBe(`${PDF_NAME}|${PDF_BYTES.length}|%PDF-`)

      // The planner saw the file by id only; the path never left the main process.
      expect(plannedStates[0]!.downloads).toEqual([{ id: 'd1', filename: PDF_NAME, sizeBytes: PDF_BYTES.length }])
      expect(leaksFolder(plannedStates)).toBe(false)
    } finally {
      await shell.unroute('**/api/v1/agent/plan')
    }
  })
})
