import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Exercises the Browser Runtime and agent mode against a real Chromium page.
 *
 * Everything below the UI has previously only been covered by mocks. These
 * tests drive the actual CDP path — real accessibility tree, real native input
 * events — which is the only way to catch the class of bug that mocks cannot:
 * coordinates that resolve to the wrong node, key events a page ignores,
 * waits that never settle.
 *
 * The page under test is a data: URL so the suite needs no network or fixture
 * server, and stays deterministic.
 */

const TEST_PAGE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="font-family:sans-serif;padding:20px">
  <h1>Runtime Test Page</h1>
  <label for="q">Search</label>
  <input id="q" type="search" aria-label="Search" />
  <button id="go" onclick="document.getElementById('out').textContent='clicked:'+document.getElementById('q').value">Run search</button>
  <button id="danger">Delete account</button>
  <p id="out"></p>
  <div style="height:1500px"></div>
  <a href="#bottom" id="bottom-link">Bottom link</a>
</body></html>`)}`

/**
 * A mail composer shaped like Gmail's: recipient rows that keep their chips
 * next to the input, an autocomplete popup that changes the page structure on
 * every keystroke, Gmail's habit of turning the last chip back into text when
 * Backspace hits an empty input, a Cc row that only splits on a real comma
 * key, a "click to edit" proxy that focuses a different element than the one
 * clicked, and a field that swallows input.
 */
const COMPOSE_PAGE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="font-family:sans-serif;padding:20px">
  <h1>Compose Test Page</h1>
  <div class="row">
    <span>To</span>
    <div class="chips" id="to-chips" role="listbox" aria-label="To list"></div>
    <input id="to" role="combobox" aria-label="To recipients" aria-autocomplete="list" aria-expanded="false" aria-controls="suggest" />
    <div id="suggest" role="listbox" aria-label="Suggestions" hidden></div>
  </div>
  <div class="row">
    <span>Cc</span>
    <div class="chips" id="cc-chips" role="listbox" aria-label="Cc list"></div>
    <input id="cc" role="combobox" aria-label="Cc recipients" />
  </div>
  <input id="subject" aria-label="Subject" />
  <div id="note-proxy" role="textbox" tabindex="0" aria-label="Add a note">Add a note</div>
  <textarea id="note" aria-label="Note text" style="display:none"></textarea>
  <input id="locked" aria-label="Locked field" />
  <div id="locked-popup" role="listbox" aria-label="Locked suggestions" hidden><div role="option">Suggestion</div></div>
  <script>
    function addChip(list, address) {
      const chip = document.createElement('div');
      chip.setAttribute('role', 'option');
      chip.setAttribute('data-hovercard-id', address);
      chip.className = 'chip';
      chip.textContent = address;
      list.appendChild(chip);
    }

    function chipField(input, list, splitsOn) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Backspace' && input.value === '' && list.lastElementChild) {
          event.preventDefault();
          input.value = list.lastElementChild.textContent;
          list.lastElementChild.remove();
          return;
        }
        if (!splitsOn(event) || !input.value.trim()) return;
        event.preventDefault();
        addChip(list, input.value.replace(/,/g, '').trim());
        input.value = '';
        input.dispatchEvent(new Event('input'));
      });
    }

    const to = document.getElementById('to');
    const suggest = document.getElementById('suggest');
    to.addEventListener('input', () => {
      suggest.hidden = !to.value;
      to.setAttribute('aria-expanded', String(!!to.value));
      suggest.innerHTML = to.value ? '<div role="option">' + to.value.replace(/</g, '') + '</div>' : '';
    });
    chipField(to, document.getElementById('to-chips'), (event) => event.key === 'Enter');
    chipField(document.getElementById('cc'), document.getElementById('cc-chips'), (event) => event.keyCode === 188);

    const proxy = document.getElementById('note-proxy');
    const note = document.getElementById('note');
    proxy.addEventListener('mousedown', (event) => {
      event.preventDefault();
      note.style.display = 'block';
      note.focus();
    });

    const locked = document.getElementById('locked');
    locked.addEventListener('keydown', (event) => {
      event.preventDefault();
      document.getElementById('locked-popup').hidden = false;
    });
  </script>
</body></html>`)}`

type RuntimeResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

test.describe('Browser Runtime over real CDP', () => {
  let app: ElectronApplication
  let window: Page

  test.beforeAll(async () => {
    // See app.spec.ts: electron.exe behaves as plain Node when this is set,
    // and then rejects the Chromium switches Playwright needs.
    const cleanEnv = { ...process.env }
    delete cleanEnv.ELECTRON_RUN_AS_NODE

    app = await electron.launch({
      args: [path.join(__dirname, '../dist-electron/main.js')],
      env: { ...cleanEnv, PROMPT_DEFENSE_DEV: 'false' },
    })
    window = await app.firstWindow()

    await window.locator('.start-button').click()
    await expect(window.locator('.browser-frame')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
  })

  /** Reads the active tab's runtime target id off the container BrowserWebView.tsx tags with it. */
  async function activeTargetId(): Promise<number> {
    return await window.evaluate(() => {
      const container = document.querySelector('.browser-webview[data-webcontents-id]') as HTMLElement
      return Number(container.dataset.webcontentsId)
    })
  }

  /** Loads a fixture page into the active tab and returns its runtime target id. */
  async function loadTestPage(page = TEST_PAGE): Promise<number> {
    const targetId = await activeTargetId()
    await window.evaluate(
      ([id, url]) => window.electronAPI!.browser.navigate(id as number, url as string),
      [targetId, page] as const,
    )

    // Wait for the runtime to report the page, rather than sleeping.
    await expect.poll(async () => {
      return await window.evaluate(async ([id, url]) => {
        const described = await window.electronAPI!.runtimeInvoke({
          targetId: id, name: 'describeTarget', params: {},
        }) as RuntimeResult<{ url: string }>
        return described.ok && described.data.url === url ? id : null
      }, [targetId, page] as const)
    }, { timeout: 20000 }).not.toBeNull()

    return targetId
  }

  async function invoke<T>(targetId: number, name: string, params: Record<string, unknown> = {}) {
    return await window.evaluate(
      ([id, command, args]) => window.electronAPI!.runtimeInvoke({
        targetId: id as number, name: command as string, params: args as Record<string, unknown>,
      }) as Promise<unknown>,
      [targetId, name, params] as const,
    ) as RuntimeResult<T>
  }

  test('extracts semantic state from the real accessibility tree', async () => {
    const targetId = await loadTestPage()
    const state = await invoke<{
      url: string
      elements: { id: string; role: string; name: string }[]
    }>(targetId, 'extractPageState')

    expect(state.ok).toBe(true)
    if (!state.ok) return

    const roles = state.data.elements.map((element) => element.role)
    // Chromium's own AX computation must be producing real controls here.
    expect(roles).toContain('button')
    expect(state.data.elements.some((element) => element.name.includes('Run search'))).toBe(true)
    expect(state.data.elements.some((element) => /searchbox|textbox|combobox/.test(element.role))).toBe(true)
    // Decorative content must not leak into the planner's view.
    expect(roles).not.toContain('StaticText')
    expect(roles).not.toContain('paragraph')
  })

  test('fills a field with native key events and verifies the value landed', async () => {
    const targetId = await loadTestPage()
    const state = await invoke<{ elements: { id: string; role: string; name: string }[] }>(targetId, 'extractPageState')
    expect(state.ok).toBe(true)
    if (!state.ok) return

    const field = state.data.elements.find((element) => /searchbox|textbox|combobox/.test(element.role))
    expect(field, 'no text field found in semantic state').toBeTruthy()

    const filled = await invoke<{ verification: { verified: boolean; reason: string } }>(
      targetId, 'fill', { elementId: field!.id, value: 'hello agent' },
    )
    expect(filled.ok).toBe(true)
    if (!filled.ok) return
    expect(filled.data.verification.verified, filled.data.verification.reason).toBe(true)

    // And the page really received it, not just the accessibility layer.
    const value = await app.evaluate(
      ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('document.getElementById("q").value'),
      targetId,
    )
    expect(value).toBe('hello agent')
  })

  test('clicks a real button and the page handler runs', async () => {
    const targetId = await loadTestPage()
    let state = await invoke<{ elements: { id: string; role: string; name: string }[] }>(targetId, 'extractPageState')
    expect(state.ok).toBe(true)
    if (!state.ok) return

    const field = state.data.elements.find((element) => /searchbox|textbox|combobox/.test(element.role))!
    await invoke(targetId, 'fill', { elementId: field.id, value: 'shoes' })

    state = await invoke<{ elements: { id: string; role: string; name: string }[] }>(targetId, 'extractPageState')
    if (!state.ok) return
    const button = state.data.elements.find((element) => element.name.includes('Run search'))!

    const clicked = await invoke<{ verification: { verified: boolean } }>(targetId, 'click', { elementId: button.id })
    expect(clicked.ok).toBe(true)

    // The click must have run the page's own onclick handler.
    const output = await app.evaluate(
      ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('document.getElementById("out").textContent'),
      targetId,
    )
    expect(output).toBe('clicked:shoes')
  })

  test('scrolls with a native wheel event and verification sees the viewport move', async () => {
    const targetId = await loadTestPage()
    const scrolled = await invoke<{ verification: { verified: boolean; scrollChanged: boolean } }>(
      targetId, 'scroll', { deltaY: 600 },
    )
    expect(scrolled.ok).toBe(true)
    if (!scrolled.ok) return
    expect(scrolled.data.verification.scrollChanged).toBe(true)
    expect(scrolled.data.verification.verified).toBe(true)
  })

  test('captures a screenshot of the real page', async () => {
    const targetId = await loadTestPage()
    const shot = await invoke<{ format: string; dataBase64: string }>(targetId, 'captureScreenshot', {})
    expect(shot.ok).toBe(true)
    if (!shot.ok) return
    expect(shot.data.format).toBe('png')
    // A real PNG, not an empty string: iVBORw0KGgo is the PNG magic in base64.
    expect(shot.data.dataBase64.startsWith('iVBORw0KGgo')).toBe(true)
  })

  test('captures a deep security snapshot for the agent scan', async () => {
    const targetId = await loadTestPage()
    const snapshot = await invoke<{ visible_text: string; url: string }>(targetId, 'captureSecuritySnapshot', {})
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    expect(snapshot.data.visible_text).toContain('Runtime Test Page')
  })

  test('refuses javascript: navigation', async () => {
    const targetId = await loadTestPage()
    const blocked = await invoke(targetId, 'navigate', { url: 'javascript:alert(1)' })
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.error.code).toBe('NAVIGATION_BLOCKED')
  })

  type FillResult = { verification: { verified: boolean; reason: string } }
  type StateElements = { elements: { id: string; role: string; name: string }[] }

  async function composeElement(targetId: number, name: string): Promise<string> {
    const state = await invoke<StateElements>(targetId, 'extractPageState')
    expect(state.ok).toBe(true)
    if (!state.ok) throw new Error('state extraction failed')
    const element = state.data.elements.find((candidate) => candidate.name === name)
    expect(element, `no "${name}" element in semantic state`).toBeTruthy()
    return element!.id
  }

  async function pageValue(targetId: number, expression: string): Promise<unknown> {
    return await app.evaluate(
      ({ webContents }, [id, script]) => webContents.fromId(id as number)!.executeJavaScript(script as string),
      [targetId, expression] as const,
    )
  }

  test('fill commits an email address in a recipient token field as a chip', async () => {
    const targetId = await loadTestPage(COMPOSE_PAGE)
    const to = await composeElement(targetId, 'To recipients')

    const filled = await invoke<FillResult>(targetId, 'fill', { elementId: to, value: 'salmantahir610@gmail.com' })
    expect(filled.ok).toBe(true)
    if (!filled.ok) return
    expect(filled.data.verification.verified, filled.data.verification.reason).toBe(true)
    expect(filled.data.verification.reason).toContain('Added salmantahir610@gmail.com as a recipient')

    const chips = await pageValue(targetId, '[...document.querySelectorAll("#to-chips .chip")].map((chip) => chip.textContent)')
    expect(chips).toEqual(['salmantahir610@gmail.com'])
    expect(await pageValue(targetId, 'document.getElementById("to").value')).toBe('')
  })

  test('fill commits every address in a recipient list', async () => {
    const targetId = await loadTestPage(COMPOSE_PAGE)
    const to = await composeElement(targetId, 'To recipients')

    const filled = await invoke<FillResult>(targetId, 'fill', { elementId: to, value: 'a@example.com, b@example.org' })
    expect(filled.ok).toBe(true)
    if (!filled.ok) return
    expect(filled.data.verification.verified, filled.data.verification.reason).toBe(true)

    const chips = await pageValue(targetId, '[...document.querySelectorAll("#to-chips .chip")].map((chip) => chip.textContent)')
    expect(chips).toEqual(['a@example.com', 'b@example.org'])
  })

  test('re-filling a recipient that is already a chip does not add it twice', async () => {
    const targetId = await loadTestPage(COMPOSE_PAGE)
    const first = await invoke<FillResult>(targetId, 'fill', {
      elementId: await composeElement(targetId, 'To recipients'), value: 'salmantahir610@gmail.com',
    })
    expect(first.ok).toBe(true)

    // The planner cannot see the chip as a field value, so it retries.
    const second = await invoke<FillResult>(targetId, 'fill', {
      elementId: await composeElement(targetId, 'To recipients'), value: 'salmantahir610@gmail.com',
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.verification.verified, second.data.verification.reason).toBe(true)
    expect(second.data.verification.reason).toContain('already a recipient')

    const chips = await pageValue(targetId, '[...document.querySelectorAll("#to-chips .chip")].map((chip) => chip.textContent)')
    expect(chips).toEqual(['salmantahir610@gmail.com'])
    expect(await pageValue(targetId, 'document.getElementById("to").value')).toBe('')
  })

  test('falls back to a comma when the recipient field ignores Enter', async () => {
    const targetId = await loadTestPage(COMPOSE_PAGE)
    const filled = await invoke<FillResult>(targetId, 'fill', {
      elementId: await composeElement(targetId, 'Cc recipients'), value: 'mentor@example.com',
    })
    expect(filled.ok).toBe(true)
    if (!filled.ok) return
    expect(filled.data.verification.verified, filled.data.verification.reason).toBe(true)
    expect(filled.data.verification.reason).toContain('Added mentor@example.com as a recipient')

    const chips = await pageValue(targetId, '[...document.querySelectorAll("#cc-chips .chip")].map((chip) => chip.textContent)')
    expect(chips).toEqual(['mentor@example.com'])
    expect(await pageValue(targetId, 'document.getElementById("cc").value')).toBe('')
  })

  test('fill does not press Enter in an ordinary field', async () => {
    const targetId = await loadTestPage(COMPOSE_PAGE)
    const subject = await composeElement(targetId, 'Subject')

    const filled = await invoke<FillResult>(targetId, 'fill', { elementId: subject, value: 'Week 4 progress' })
    expect(filled.ok).toBe(true)
    if (!filled.ok) return
    expect(filled.data.verification.verified, filled.data.verification.reason).toBe(true)
    expect(await pageValue(targetId, 'document.getElementById("subject").value')).toBe('Week 4 progress')
    expect(await pageValue(targetId, 'document.querySelectorAll(".chip").length')).toBe(0)
  })

  test('fill keeps the focus a click-to-edit proxy hands to its real field', async () => {
    const targetId = await loadTestPage(COMPOSE_PAGE)
    const proxy = await composeElement(targetId, 'Add a note')

    const filled = await invoke<FillResult>(targetId, 'fill', { elementId: proxy, value: 'remember the slides' })
    expect(filled.ok).toBe(true)
    if (!filled.ok) return
    expect(filled.data.verification.verified, filled.data.verification.reason).toBe(true)
    expect(await pageValue(targetId, 'document.getElementById("note").value')).toBe('remember the slides')
  })

  test('fill reports failure when the text never reaches the field, even though the page changed', async () => {
    const targetId = await loadTestPage(COMPOSE_PAGE)
    const locked = await composeElement(targetId, 'Locked field')

    const filled = await invoke<FillResult>(targetId, 'fill', { elementId: locked, value: 'should not land' })
    expect(filled.ok).toBe(true)
    if (!filled.ok) return
    expect(filled.data.verification.verified).toBe(false)
    expect(filled.data.verification.reason).toContain('did not reach the field')
  })

  test('reports a stale element id rather than clicking the wrong node', async () => {
    const targetId = await loadTestPage()
    const stale = await invoke(targetId, 'click', { elementId: 'e9999' })
    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.error.code).toBe('ELEMENT_NOT_FOUND')
  })
})

test.describe('Agent mode UI', () => {
  let app: ElectronApplication
  let window: Page

  test.beforeAll(async () => {
    const cleanEnv = { ...process.env }
    delete cleanEnv.ELECTRON_RUN_AS_NODE
    app = await electron.launch({
      args: [path.join(__dirname, '../dist-electron/main.js')],
      env: { ...cleanEnv, PROMPT_DEFENSE_DEV: 'false' },
    })
    window = await app.firstWindow()
    await window.locator('.start-button').click()
    await expect(window.locator('.browser-frame')).toBeVisible()
    await window.locator('.assistant-pill').click()
  })

  test.afterAll(async () => {
    await app?.close()
  })

  test('offers chat and agent as separate modes, with chat first', async () => {
    const panel = window.locator('[aria-label="Kimo panel"]')
    await expect(panel).toBeVisible()

    const chatTab = panel.locator('.assistant-mode-tab', { hasText: 'Chat' })
    const agentTab = panel.locator('.assistant-mode-tab', { hasText: 'Agent' })
    await expect(chatTab).toHaveAttribute('aria-selected', 'true')
    await expect(agentTab).toHaveAttribute('aria-selected', 'false')
  })

  test('switching to agent mode reveals the goal composer', async () => {
    const panel = window.locator('[aria-label="Kimo panel"]')
    await panel.locator('.assistant-mode-tab', { hasText: 'Agent' }).click()

    await expect(panel.locator('[aria-label="Agent mode"]')).toBeVisible()
    await expect(panel.locator('.agent-goal-input')).toBeVisible()
    await expect(panel.locator('.agent-run-button')).toBeDisabled()

    await panel.locator('.agent-goal-input').fill('find the cheapest flight')
    await expect(panel.locator('.agent-run-button')).toBeEnabled()
  })

  test('switching to chat hides agent mode without discarding its state', async () => {
    const panel = window.locator('[aria-label="Kimo panel"]')

    await panel.locator('.assistant-mode-tab', { hasText: 'Agent' }).click()
    await panel.locator('.agent-goal-input').fill('a goal that should persist')

    await panel.locator('.assistant-mode-tab', { hasText: 'Chat' }).click()
    await expect(panel.locator('.agent-goal-input')).not.toBeVisible()
    await expect(panel.locator('.chat-input-area')).toBeVisible()

    // The panel is hidden, not unmounted: a running task and a half-written
    // goal must survive a glance at the chat tab.
    await panel.locator('.assistant-mode-tab', { hasText: 'Agent' }).click()
    await expect(panel.locator('.agent-goal-input')).toHaveValue('a goal that should persist')
  })

  test('the manual Scan Page button is still available in agent mode', async () => {
    const panel = window.locator('[aria-label="Kimo panel"]')
    await panel.locator('.assistant-mode-tab', { hasText: 'Agent' }).click()

    // The manual workflow is independent of the agent and must not be hidden
    // or disabled by it.
    await expect(window.locator('.scan-button')).toBeVisible()
    await expect(window.locator('.scan-button')).toBeEnabled()
  })
})
