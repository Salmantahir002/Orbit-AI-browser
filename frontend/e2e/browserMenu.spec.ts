import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdir, readFile, access, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DownloadEntry } from '../electron/browserUITypes.js'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test.describe.serial('Browser menu and native panels', () => {
  let app: ElectronApplication
  let shell: Page
  let overlay: Page
  let server: Server
  let origin: string
  let downloadsFolder: string
  let profileFolder: string
  let closed = false

  test.beforeAll(async () => {
    const info = test.info()
    const profile = info.outputPath('browser-profile')
    profileFolder = profile
    downloadsFolder = info.outputPath('downloads')
    await mkdir(downloadsFolder, { recursive: true })
    server = createServer((request, response) => {
      if (request.url?.startsWith('/download')) {
        const slow = request.url.includes('slow')
        const size = slow ? 4 * 1024 * 1024 : 32 * 1024
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="orbit-test.bin"', 'Content-Length': size })
        if (!slow) { response.end(Buffer.alloc(size, 7)); return }
        let sent = 0
        const timer = setInterval(() => { const bytes = Math.min(32 * 1024, size - sent); response.write(Buffer.alloc(bytes, 7)); sent += bytes; if (sent >= size) { clearInterval(timer); response.end() } }, 80)
        response.on('close', () => clearInterval(timer))
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'orbit-menu-test=yes; Path=/' })
      response.end('<html><head><title>Orbit local test page</title></head><body style="margin:0;background:#12364a;color:white;font-family:system-ui"><h1>Native website stays visible</h1><a href="/second">Next page</a></body></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local server failed to start')
    origin = `http://127.0.0.1:${address.port}`
    const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PROMPT_DEFENSE_DEV: 'false', ORBIT_USER_DATA_DIR: profile }).filter((entry): entry is [string, string] => entry[1] !== undefined))
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ args: [path.join(frontend, 'dist-electron/main.js')], env })
    shell = await app.firstWindow()
    await expect(shell.locator('.start-button')).toBeVisible()
    await shell.locator('.start-button').click()
    await expect(shell.locator('.browser-frame')).toBeVisible()
    await expect.poll(() => app.context().pages().some((page) => page.url().includes('surface=browser-overlay'))).toBe(true)
    overlay = app.context().pages().find((page) => page.url().includes('surface=browser-overlay'))!
    await expect.poll(() => shell.locator('.browser-webview[data-webcontents-id]').count()).toBe(1)
  })

  test.afterAll(async () => {
    if (app && !closed) await app.close()
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  const target = async () => Number(await shell.locator('.webview-stage:not(.webview-stage--inactive) .browser-webview').getAttribute('data-webcontents-id'))
  async function show(panel: 'menu' | 'history' | 'downloads' | 'bookmarks' | 'settings' | 'clear-data' | 'about') {
    await shell.evaluate(({ panel, id }) => window.electronAPI!.browserUI.show(panel, id, { x: window.innerWidth - 16, y: 72 }), { panel, id: await target() })
  }
  async function closePanel() {
    await overlay.keyboard.press('Escape')
    await expect.poll(() => shell.getByRole('button', { name: 'Customize and control browser' }).getAttribute('aria-expanded')).toBe('false')
  }
  async function captureNative(filename: string) {
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    await writeFile(test.info().outputPath(filename), Buffer.from(data, 'base64'))
  }
  async function shortcut(keyCode: string) {
    // Exercise Electron's input path; CDP keyboard injection bypasses before-input-event.
    await app.evaluate(({ BrowserWindow }, key) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.focus()
      window.webContents.focus()
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['control'] })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['control'] })
    }, keyCode)
  }

  test('menu renders above an active native website and closes with Escape', async () => {
    await shell.getByRole('textbox', { name: 'Address and search bar' }).fill(origin)
    await shell.getByRole('textbox', { name: 'Address and search bar' }).press('Enter')
    await expect(shell.locator('.active-tab .tab-title')).toHaveText('Orbit local test page')
    await shell.getByRole('button', { name: 'Customize and control browser' }).click()
    await expect(overlay.getByRole('menuitem', { name: 'New window' })).toBeVisible()
    await expect(overlay.getByRole('menuitem', { name: 'About Orbit' })).toBeVisible()
    const layered = await app.evaluate(({ BrowserWindow, webContents }, id) => {
      const window = BrowserWindow.getAllWindows()[0]
      const children = window.contentView.children
      const guest = children.find((view) => 'webContents' in view && (view as Electron.WebContentsView).webContents.id === id) as Electron.WebContentsView
      const top = children[children.length - 1] as Electron.WebContentsView
      return { guestBounds: guest.getBounds(), overlayVisible: top.getVisible(), overlayURL: top.webContents.getURL(), guestURL: webContents.fromId(id)!.getURL() }
    }, await target())
    expect(layered.guestBounds.width).toBeGreaterThan(500)
    expect(layered.overlayVisible).toBe(true)
    expect(layered.overlayURL).toContain('surface=browser-overlay')
    expect(layered.guestURL).toContain(origin)
    await expect(overlay.locator('.bp-menu')).toHaveCSS('opacity', '1')
    await captureNative('menu-over-website.png')
    await overlay.screenshot({ path: test.info().outputPath('menu-ui.png'), omitBackground: true })
    await closePanel()
    await expect(shell.getByRole('button', { name: 'Customize and control browser' })).toBeFocused()
  })

  test('menu and shortcuts create tabs, and zoom changes the guest page', async () => {
    await show('menu')
    await overlay.getByRole('button', { name: 'Zoom in', exact: true }).click()
    expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getZoomFactor(), await target())).toBeCloseTo(1.1)
    await overlay.getByRole('button', { name: 'Reset zoom' }).click()
    expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getZoomFactor(), await target())).toBe(1)
    await overlay.getByRole('menuitem', { name: 'New tab' }).click()
    await expect(shell.locator('.tab')).toHaveCount(2)
    await expect.poll(() => shell.locator('.webview-stage:not(.webview-stage--inactive) .browser-webview').getAttribute('data-webcontents-id')).not.toBeNull()
    const homepageTitle = shell.locator('.webview-stage:not(.webview-stage--inactive) .homepage-hero-title')
    const originalWidth = (await homepageTitle.boundingBox())!.width
    await show('menu')
    await overlay.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await expect.poll(async () => (await homepageTitle.boundingBox())!.width).toBeGreaterThan(originalWidth * 1.05)
    await overlay.getByRole('button', { name: 'Reset zoom' }).click()
    await closePanel()
    await shortcut('T')
    await expect(shell.locator('.tab')).toHaveCount(3)
    await shortcut('W')
    await expect(shell.locator('.tab')).toHaveCount(2)
    await shell.locator('.tab').first().click()
  })

  test('history and bookmarks have working search, edit, delete, and shared storage', async () => {
    await show('menu')
    await overlay.getByRole('menuitem', { name: 'History', exact: true }).hover()
    await overlay.getByRole('menuitem', { name: 'Show all history' }).click()
    await overlay.getByRole('searchbox', { name: 'Search history' }).fill('Orbit local')
    await expect(overlay.locator('.bp-history-row')).toHaveCount(1)
    await overlay.getByRole('searchbox', { name: 'Search history' }).fill('no matching page')
    await expect(overlay.getByText('No matching visits')).toBeVisible()
    await closePanel()
    await shell.getByRole('button', { name: 'Bookmark this tab' }).click()
    await show('menu')
    await overlay.getByRole('menuitem', { name: 'Bookmarks', exact: true }).hover()
    await overlay.getByRole('menuitem', { name: 'Bookmark manager' }).click()
    await expect(overlay.locator('.bp-bookmark-row')).toHaveCount(1)
    await overlay.getByRole('button', { name: 'Edit bookmark: Orbit local test page' }).click()
    await overlay.getByLabel('Name', { exact: true }).fill('Saved local page')
    await overlay.getByRole('button', { name: 'Save bookmark' }).click()
    await expect(overlay.locator('.bp-bookmark-row strong')).toHaveText('Saved local page')
    await expect(shell.locator('.bookmark-item-btn')).toContainText('Saved local page')
    await closePanel()
  })

  test('new windows own independent tabs and cannot address another window’s guest', async () => {
    await show('menu')
    await overlay.getByRole('menuitem', { name: 'New window' }).click()
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2)
    await expect.poll(() => app.context().pages().filter((page) => page.url().includes('start=browser')).length).toBe(1)
    const second = app.context().pages().find((page) => page.url().includes('start=browser'))!
    await expect(second.locator('.browser-frame')).toBeVisible()
    await expect.poll(() => second.locator('.browser-webview[data-webcontents-id]').count()).toBe(1)
    const secondId = Number(await second.locator('.browser-webview').getAttribute('data-webcontents-id'))
    expect(await shell.evaluate((id) => window.electronAPI!.browser.getTabInfo(id), secondId)).toBeNull()
    await second.evaluate(() => window.electronAPI!.browserUI.saveBookmark({ title: 'Second window bookmark', url: 'https://example.com/' }))
    await expect.poll(() => shell.evaluate(async () => (await window.electronAPI!.browserUI.snapshot()).bookmarks.length)).toBe(2)
    await second.evaluate(() => window.electronAPI!.browserUI.closeWindow()).catch((error: unknown) => { if (!second.isClosed()) throw error })
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    expect(await shell.evaluate(async () => (await window.electronAPI!.browser.getTabInfo(Number(document.querySelector('.browser-webview')!.getAttribute('data-webcontents-id'))))?.url)).toContain(origin)
  })

  test('settings choose a real folder, persist zoom and bookmarks visibility', async () => {
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, downloadsFolder)
    await show('settings')
    await overlay.getByRole('button', { name: 'Change', exact: true }).click()
    await expect(overlay.locator('.bp-folder-path')).toHaveText(downloadsFolder)
    await overlay.getByRole('switch', { name: 'Show bookmarks bar' }).click()
    await expect(shell.locator('.bookmark-bar')).not.toBeVisible()
    await overlay.getByLabel('Default page zoom').selectOption('125')
    await overlay.getByRole('switch', { name: 'Show bookmarks bar' }).click()
    await overlay.getByRole('switch', { name: 'Ask where to save each file' }).click()
    await expect(overlay.getByRole('switch', { name: 'Ask where to save each file' })).toHaveAttribute('aria-checked', 'true')
    await overlay.getByRole('switch', { name: 'Ask where to save each file' }).click()
    await captureNative('settings-over-website.png')
    await overlay.screenshot({ path: test.info().outputPath('settings-ui.png'), omitBackground: true })
    await closePanel()
    await shortcut('T')
    await expect.poll(() => shell.locator('.tab').count()).toBe(3)
    await expect.poll(async () => app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomFactor(), await target())).toBe(1.25)
    await shortcut('W')
    await shell.locator('.tab').first().click()
  })

  test('downloads report progress, pause, resume, cancel, and safely save duplicate files', async () => {
    const id = await target()
    await app.evaluate(({ webContents }, { id, url }) => webContents.fromId(id)!.downloadURL(url), { id, url: `${origin}/download?slow` })
    await expect(overlay.getByRole('heading', { name: 'Downloads', exact: true })).toBeVisible()
    await expect.poll(() => shell.evaluate(async () => (await window.electronAPI!.browserUI.snapshot()).downloads[0]?.receivedBytes ?? 0)).toBeGreaterThan(0)
    await expect(overlay.getByRole('progressbar')).toBeVisible()
    await overlay.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(overlay.getByText('Paused', { exact: true })).toBeVisible()
    await overlay.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(overlay.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await overlay.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(overlay.getByText('Cancelled', { exact: true })).toBeVisible()
    const cancelledId = await shell.evaluate(async () => (await window.electronAPI!.browserUI.snapshot()).downloads[0].id)
    await app.evaluate(({ webContents }, { id, url }) => webContents.fromId(id)!.downloadURL(url), { id, url: `${origin}/download` })
    await expect.poll(() => shell.evaluate(async () => (await window.electronAPI!.browserUI.snapshot()).downloads[0]?.id)).not.toBe(cancelledId)
    await expect.poll(() => shell.evaluate(async () => (await window.electronAPI!.browserUI.snapshot()).downloads[0]?.state)).toBe('completed')
    const first = await shell.evaluate(async () => (await window.electronAPI!.browserUI.snapshot()).downloads[0])
    expect(first.savePath).toContain(downloadsFolder)
    expect((await readFile(first.savePath)).length).toBe(32 * 1024)
    await app.evaluate(({ webContents }, { id, url }) => webContents.fromId(id)!.downloadURL(url), { id, url: `${origin}/download` })
    await expect.poll(() => shell.evaluate(async () => (await window.electronAPI!.browserUI.snapshot()).downloads[0]?.id)).not.toBe(first.id)
    await expect.poll(() => shell.evaluate(async () => (await window.electronAPI!.browserUI.snapshot()).downloads[0]?.state)).toBe('completed')
    const second = await shell.evaluate(async () => (await window.electronAPI!.browserUI.snapshot()).downloads[0])
    expect(second.savePath).not.toBe(first.savePath)
    await expect.poll(() => overlay.locator('.bp-download-card').evaluateAll((cards) => cards.every((card) => !((card as HTMLElement).style.transform) || (card as HTMLElement).style.transform === 'none'))).toBe(true)
    await captureNative('downloads-over-website.png')
    await overlay.screenshot({ path: test.info().outputPath('downloads-ui.png'), omitBackground: true })
    // Opening/revealing files is asserted with an OS API spy, keeping the test self-contained.
    await app.evaluate(({ shell }) => { shell.openPath = async () => ''; shell.showItemInFolder = () => {} })
    await overlay.getByRole('button', { name: 'Open file', exact: true }).first().click()
    await overlay.getByRole('button', { name: 'Show in folder', exact: true }).first().click()
    await expect(overlay.getByRole('alert')).toHaveCount(0)
    const chosenPath = path.join(downloadsFolder, 'chosen-file.bin')
    await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialogSync = () => filename }, chosenPath)
    await shell.evaluate(() => window.electronAPI!.browserUI.updateSettings({ askWhereToSave: true }))
    const previousCount = await shell.evaluate(async () => (await window.electronAPI!.browserUI.snapshot()).downloads.length)
    await app.evaluate(({ webContents }, { id, url }) => webContents.fromId(id)!.downloadURL(url), { id, url: `${origin}/download` })
    await expect.poll(() => shell.evaluate(async () => (await window.electronAPI!.browserUI.snapshot()).downloads.length)).toBe(previousCount + 1)
    await expect.poll(() => shell.evaluate(async () => (await window.electronAPI!.browserUI.snapshot()).downloads[0]?.state)).toBe('completed')
    expect((await readFile(chosenPath)).length).toBe(32 * 1024)
    await shell.evaluate(() => window.electronAPI!.browserUI.updateSettings({ askWhereToSave: false }))
    await closePanel()
  })

  test('clearing selected data leaves bookmarks and downloaded files intact, and About shows runtime versions', async () => {
    const completed = await shell.evaluate(async () => (await window.electronAPI!.browserUI.snapshot()).downloads.find((entry: DownloadEntry) => entry.state === 'completed')!)
    await show('clear-data')
    await overlay.getByLabel('Time range', { exact: true }).selectOption('all')
    await overlay.getByLabel('Download history', { exact: false }).check()
    await overlay.getByLabel('Cookies and other site data', { exact: false }).check()
    await overlay.getByRole('button', { name: 'Delete data', exact: true }).click()
    await expect(overlay.getByText('Selected browsing data deleted.')).toBeVisible()
    const data = await shell.evaluate(() => window.electronAPI!.browserUI.snapshot())
    expect(data.history).toHaveLength(0)
    expect(data.downloads).toHaveLength(0)
    expect(data.bookmarks).toHaveLength(2)
    await access(completed.savePath)
    expect(await app.evaluate(async ({ session }, url) => (await session.defaultSession.cookies.get({ url })).length, origin)).toBe(0)
    await closePanel()
    await show('about')
    await expect(overlay.getByText('Chromium', { exact: true })).toBeVisible()
    await expect(overlay.locator('.bp-version')).toHaveText(`Version ${data.versions.orbit}`)
    await closePanel()
    await show('bookmarks')
    await overlay.getByRole('button', { name: 'Delete bookmark: Saved local page' }).click()
    await expect(overlay.locator('.bp-bookmark-row')).toHaveCount(1)
    await closePanel()
  })

  test('profile preferences and bookmarks survive restarting Orbit', async () => {
    await app.close()
    const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PROMPT_DEFENSE_DEV: 'false', ORBIT_USER_DATA_DIR: profileFolder }).filter((entry): entry is [string, string] => entry[1] !== undefined))
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ args: [path.join(frontend, 'dist-electron/main.js')], env })
    shell = await app.firstWindow()
    await expect(shell.locator('.start-button')).toBeVisible()
    const data = await shell.evaluate(() => window.electronAPI!.browserUI.snapshot())
    expect(data.bookmarks).toHaveLength(1)
    expect(data.bookmarks[0].title).toBe('Second window bookmark')
    expect(data.settings.downloadFolder).toBe(downloadsFolder)
    expect(data.settings.defaultZoom).toBe(125)
    expect(data.history).toHaveLength(0)
    await shell.locator('.start-button').click()
    await expect(shell.locator('.browser-frame')).toBeVisible()
    await expect.poll(() => app.context().pages().some((page) => page.url().includes('surface=browser-overlay'))).toBe(true)
    overlay = app.context().pages().find((page) => page.url().includes('surface=browser-overlay'))!
  })

  test('Exit closes the application', async () => {
    await show('menu')
    const exited = app.waitForEvent('close')
    await overlay.getByRole('menuitem', { name: 'Exit', exact: true }).click()
    await exited
    closed = true
  })
})
