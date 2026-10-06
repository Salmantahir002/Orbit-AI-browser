import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

test.describe('Prompt Defense Application E2E tests', () => {
  let electronApp: ElectronApplication
  let window: Page

  test.beforeAll(async () => {
    // ELECTRON_RUN_AS_NODE makes electron.exe behave as a plain Node binary,
    // which then rejects Chromium switches such as --remote-debugging-port
    // that Playwright needs to attach. Some shells and IDE terminals export
    // it, so it is stripped explicitly rather than inherited.
    const cleanEnv = { ...process.env }
    delete cleanEnv.ELECTRON_RUN_AS_NODE

    electronApp = await electron.launch({
      args: [path.join(__dirname, '../dist-electron/main.js')],
      env: {
        ...cleanEnv,
        // Last, so the production-like path is not overridden by the shell.
        PROMPT_DEFENSE_DEV: 'false',
      },
    })

    // Wait for the first window to open
    window = await electronApp.firstWindow()
  })

  test.afterAll(async () => {
    // Clean up and close the Electron application
    if (electronApp) {
      await electronApp.close()
    }
  })

  async function openBrowserShell() {
    const startButton = window.locator('.start-button')
    const browserFrame = window.locator('.browser-frame')

    // The window exists before React has rendered into it, so wait for whichever
    // screen is up rather than sampling isVisible() once and skipping the click.
    await startButton.or(browserFrame).first().waitFor({ state: 'visible' })
    if (await startButton.isVisible()) {
      await startButton.click()
    }

    await expect(browserFrame).toBeVisible()
  }

  test('should load startup screen correctly', async () => {
    // Verify window title
    expect(await window.title()).toBe('Orbit')

    // Verify the welcome screen header
    const welcomeTitle = window.locator('.welcome-title')
    await expect(welcomeTitle).toBeVisible()
    await expect(welcomeTitle).toHaveText('Welcome to Orbit')

    // Verify presence of solar system animations and the Get started button
    const solarSystem = window.locator('.solar-system')
    await expect(solarSystem).toBeVisible()

    const startButton = window.locator('.start-button')
    await expect(startButton).toBeVisible()
    await expect(startButton).toContainText('Get started')
  })

  test('should transition to browser shell on clicking Get started', async () => {
    await openBrowserShell()

    const toolbar = window.locator('[aria-label="Browser toolbar"]')
    await expect(toolbar).toBeVisible()
  })

  test('should display default toolbar state and initial address value', async () => {
    await openBrowserShell()

    // A new tab deliberately starts with an empty address field.
    const addressInput = window.locator('input[aria-label="Address and search bar"]')
    await expect(addressInput).toBeVisible()
    await expect(addressInput).toHaveValue('')

    // Back, Forward and Reload buttons should render
    await expect(window.locator('button[aria-label="Back"]')).toBeVisible()
    await expect(window.locator('button[aria-label="Forward"]')).toBeVisible()
    await expect(window.locator('button[aria-label="Reload this page"]')).toBeVisible()

    // Scan and Assistant buttons should render
    await expect(window.locator('.scan-button')).toBeVisible()
    await expect(window.locator('.assistant-pill')).toBeVisible()
  })

  test('should toggle AI Assistant Sidebar correctly', async () => {
    await openBrowserShell()

    // Assert assistant panel is not visible initially
    const assistantPanel = window.locator('[aria-label="Kimo panel"]')
    await expect(assistantPanel).not.toBeVisible()

    // Click the assistant toggle button in the toolbar
    const assistantPill = window.locator('.assistant-pill')
    await assistantPill.click()

    // Assert that the sidebar slides into view
    await expect(assistantPanel).toBeVisible()

    // Scoped to the chat welcome: agent mode stays mounted alongside it and
    // has its own heading.
    const sidebarTitle = assistantPanel.locator('.assistant-welcome h3')
    await expect(sidebarTitle).toHaveText('Kimo')

    const welcomeText = assistantPanel.locator('.assistant-welcome p')
    await expect(welcomeText).toContainText('personal prompt-defense assistant')

    // Toggle it back off
    await assistantPill.click()
    await expect(assistantPanel).not.toBeVisible()
  })

  test('keeps a site opened sign-in page in Orbit and signed in after refresh', async () => {
    await openBrowserShell()
    let docsRequests = 0
    const server = createServer((request, response) => {
      if (request.url === '/signin') {
        response.writeHead(302, { Location: '/docs', 'Set-Cookie': 'session=active; Path=/' })
        response.end()
      } else {
        response.setHeader('Content-Type', 'text/html')
        if (request.url === '/docs') docsRequests += 1
        response.end(request.url === '/docs'
          ? `<h1>${request.headers.cookie?.includes('session=active') ? 'Signed in' : 'Signed out'}</h1>`
          : '<a href="/signin" target="_blank">Sign in</a>')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server has no port')
      const guestId = Number(await window.locator('.browser-webview[data-webcontents-id]').first().getAttribute('data-webcontents-id'))
      await electronApp.evaluate(async ({ webContents }, { id, url }) => {
        await webContents.fromId(id)!.loadURL(url)
      }, { id: guestId, url: `http://127.0.0.1:${address.port}/` })
      await electronApp.evaluate(async ({ webContents }, id) => {
        await webContents.fromId(id)!.executeJavaScript('document.querySelector("a").click()', true)
      }, guestId)

      await expect(window.locator('.tab')).toHaveCount(2)
      await expect(window.locator('input[aria-label="Address and search bar"]')).toHaveValue(/\/docs$/)
      // Guest tabs are WebContentsViews, which Playwright also lists as pages, so
      // count real OS windows instead: the popup must not have opened one.
      expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
      // The tab UI owns the popup WebContentsView; inspect its rendered page through Electron.
      const activeGuestId = Number(await window.locator('.browser-webview[data-webcontents-id]').last().getAttribute('data-webcontents-id'))
      expect(activeGuestId).toBeTruthy()
      await expect.poll(() => electronApp.evaluate(async ({ webContents }, id) =>
        webContents.fromId(id)!.executeJavaScript('document.body.textContent'), activeGuestId)).toContain('Signed in')
      const requestsBeforeReload = docsRequests
      await window.locator('button[aria-label="Reload this page"]').click()
      await expect.poll(() => docsRequests).toBeGreaterThan(requestsBeforeReload)
      await expect.poll(() => electronApp.evaluate(async ({ webContents }, id) =>
        webContents.fromId(id)!.executeJavaScript('document.body.textContent'), activeGuestId)).toContain('Signed in')
      await electronApp.evaluate(async ({ webContents }, { id, url }) => {
        await webContents.fromId(id)!.loadURL(url)
      }, { id: guestId, url: `http://127.0.0.1:${address.port}/docs` })
      expect(await electronApp.evaluate(async ({ webContents }, id) =>
        webContents.fromId(id)!.executeJavaScript('document.body.textContent'), guestId)).toContain('Signed in')
    } finally {
      server.close()
    }
  })
})
