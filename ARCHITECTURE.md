# PromptGuard Browser Architecture

This document describes the implementation in this repository. PromptGuard is the Electron desktop browser whose frontend package is named orbit-browser. Its React interface provides browser tabs, a manual webpage scan, an AI chat sidebar, and an optional autonomous Agent Mode. A local Node.js/Fastify service performs prompt-injection classification and connects to the selected AI provider.

## Chapter 1 — System Boundaries

PromptGuard runs three cooperating parts:

| Part | Implementation | Main responsibility |
| --- | --- | --- |
| Electron main process | frontend/electron/main.ts | Owns the application window, guest tabs, IPC handlers, CDP sessions, file picker, provider settings, and packaged backend lifecycle. |
| React renderer | frontend/src/App.tsx and frontend/src/components/ | Renders the browser controls, scan reports, chat, provider settings, and Agent Mode; keeps tab and UI state. |
| Local backend | backend-node/src/server.ts and backend-node/src/app.ts | Serves the /api/v1 HTTP API on 127.0.0.1:8000 by default; classifies text, builds agent plans, and calls AI providers. |

The renderer calls Electron main through the API exposed by frontend/electron/preload.ts. The renderer and Electron main also call the local backend over HTTP. Browsed websites live in separate, main-owned WebContentsView instances; their page objects are not part of the React DOM.

The principal flows cross those boundaries as follows:

| Flow | Path through the implementation |
| --- | --- |
| Manual page scan | Toolbar in React → BrowserWebView handle → preload scanWebview → Electron CdpInspectionService → backend /security/check-webpage → webpage analysis drawer. |
| Chat | AI sidebar → backend /security/check-prompt → backend /llm/chat → active provider gateway → chat message in the sidebar. |
| Agent action | AgentTask in React → backend /agent/plan → frontend tool/approval handling → preload runtimeInvoke → Electron BrowserRuntime → guest tab through CDP. |

## Chapter 2 — Repository and Entry Points

| Path | Implemented role |
| --- | --- |
| frontend/electron/main.ts | Electron startup, guest-tab lifecycle, IPC, shared CDP sessions, provider synchronization. |
| frontend/electron/preload.ts | Exposes window.electronAPI to the renderer. |
| frontend/electron/browserRuntime/ | Typed agent commands, CDP sessions, semantic page state, input dispatch, waiting, verification, and visual overlay. |
| frontend/electron/cdpInspectionService.ts | Captures page content channels for the manual scanner and the runtime's security-snapshot command. |
| frontend/src/App.tsx | Browser shell, tabs, navigation, bookmarks, assistant state, and manual scan orchestration. |
| frontend/src/components/ | Browser UI, AI sidebar, scan results, agent controls, and provider settings. |
| frontend/src/services/ | HTTP clients, page-content adapter, agent loop, tool mapping, approval policy, and browser memory. |
| backend-node/src/app.ts | Builds Fastify, configures CORS and errors, waits for classifier initialization, and registers routes. |
| backend-node/src/routes/ | Health, security, chat, agent planning, and provider endpoints. |
| backend-node/src/services/ | Text preparation, detectors, explanations, planner, tool validation, provider manager, and gateways. |
| backend-node/src/dl/ | Local Prompt Guard 2 loading and ONNX inference. |
| backend-node/test/ and frontend/e2e/ | Backend Vitest and desktop Playwright tests. |

The active backend is TypeScript/Fastify. The frontend is TypeScript/React/Electron. The current frontend scripts build and start backend-node; no Python service is part of this runtime.

## Chapter 3 — Application Startup and Process Communication

In development, frontend's npm run dev invokes scripts/run-dev.mjs, which starts the dev:processes script. That script builds and starts the backend, starts Vite on localhost:5173, watches Electron TypeScript, waits for Vite and the backend health endpoint, and launches Electron. With PROMPT_DEFENSE_DEV=true, Electron does not spawn a second backend.

In packaged or end-to-end runs, frontend/electron/backendProcess.ts starts the compiled backend with Electron's executable in Node mode, sets PORT=8000, polls /api/v1/health for up to 15 seconds, and stops the child process when the app quits. backend-node/src/server.ts binds Fastify to 127.0.0.1. The three frontend HTTP clients use 127.0.0.1:8000, so changing the backend PORT setting alone does not update their target.

The preload bridge exposes tab creation and navigation, tab events and bounds, manual page capture, the typed browser-runtime invocation, app version, and provider-setting operations. Electron main checks that browser-tab and runtime requests come from the app window. The runtime also requires a registered target before it can act on a tab.

## Chapter 4 — Browser Shell and Tabs

App.tsx owns the visible tab list, selected tab, address bar state, bookmarks, scan state, assistant state, and active runtime target ID. BrowserWebView.tsx creates one guest tab through browser:create-tab when its component mounts and closes that guest when it unmounts. The component keeps the returned webContents ID as its handle; Electron main keeps the matching WebContentsView.

The browser toolbar offers address/search submission, back, forward, reload/stop, bookmark toggling, manual Scan, and the AI sidebar. The shell also provides new and close tab behavior and persists bookmarks and assistant width in renderer localStorage. The new-tab/home screen is rendered by React. Outside Electron, BrowserWebView renders an iframe preview; the main-process browser runtime is available only in Electron.

Main sends loading, navigation, title, favicon, and load-failure events back to the renderer. BrowserWebView reports its React container bounds to main so the native guest view can be placed over that area. It gives the view zero bounds when its tab is inactive, the home screen or an error is shown, or a drawer/modal or resize interaction must cover it.

BrowserToolbar and BrowserWebView implement the main browser surface. AiAssistantSidebar hosts Chat and AgentModePanel. WebpageAnalysisDetailsPanel and PromptAnalysisDetailsPanel display separate detector results; ProviderSettingsModal manages AI connections. These components receive state and callbacks from the shell rather than owning guest webContents directly.

## Chapter 5 — CDP Capture and Browser Actions

Each guest webContents has one CdpSession in CdpSessionRegistry. The manual content inspector and the agent BrowserRuntime share that attachment because Electron permits one debugger attachment per webContents. The session enables requested CDP domains, fans out protocol events, and attempts to reattach after a detach.

CdpInspectionService captures the main frame and available child frames with an isolated-world collector. It reads visible text, hidden text, comments, metadata, form values, accessibility text, shadow DOM text, script and CSS content, generated CSS text, and observed source-map references. It also reads a DOM snapshot. A failed frame collection can leave that frame's content out of the result.

The agent BrowserRuntime accepts commands through the runtime contract in frontend/electron/browserRuntime/runtimeContract.ts. Its page-state builder turns accessibility-tree data into a capped PageStateSnapshot containing named controls, element IDs, focus, dialogs, validation errors, selection, URL, and title. Element handles stay inside main and are refreshed when page state is extracted or navigation invalidates them.

Agent actions include navigation, click, fill, type, key press, scroll, upload, waits, screenshot, state extraction, a security snapshot, and the visual overlay. The runtime resolves controls to CDP nodes/coordinates, dispatches input through CDP, waits for page changes, and returns action verification where applicable. These are CDP input events, not operating-system mouse or keyboard events. Agent navigation accepts absolute HTTP(S) URLs. Upload asks the user to choose files in an Electron dialog; the planner supplies an element ID, not local file paths.

## Chapter 6 — Backend API

backend-node/src/app.ts registers these route groups under the configured prefix, /api/v1 by default:

| Method and path | Current behavior |
| --- | --- |
| GET /health | Reports health, backend/runtime versions, model load status, classifier mode, and model precision. |
| POST /security/check-prompt | Classifies a nonempty direct prompt and returns a detailed decision. |
| POST /security/check-webpage | Classifies nonempty captured webpage channels separately and returns a detailed decision. |
| GET /security/events | Returns recent security-analysis events from an in-memory store. |
| POST /llm/chat | Rechecks the supplied prompt, then sends approved chat data to the active provider or returns the no-provider response. |
| POST /agent/plan | Uses the active provider to produce and validate an action queue for the given goal, working memory, and page state. |
| GET /agent/tools | Lists the planner's registered tools and parameter metadata. |
| GET /providers/presets | Returns provider presets. |
| POST /providers/models and POST /providers/test | Fetches models or tests candidate provider credentials. |
| GET, POST, DELETE /providers/active | Reads, sets, or clears the provider active in backend memory. |
| POST /providers/configured | Loads configured providers into backend memory for fallback operations. |

Fastify uses TypeBox request/response schemas on the principal security, chat, agent, and provider routes. app.ts waits for local classifier loading to finish before registering routes. Request validation failures are returned with a detail message and status 422.

## Chapter 7 — Prompt-Injection Detection

The manual security routes use analyzeText in backend-node/src/routes/security.routes.ts. It preprocesses input, splits each source into overlapping chunks, calls promptClassifier.classifyMany once for the batch, and aggregates the result. Defaults are 800 characters per chunk with 100 characters of overlap. A single malicious chunk makes the overall decision disallowed.

promptClassifier runs the rule detector and, when loaded, the local Prompt Guard 2 classifier. A chunk is malicious when either detector matches. The rule detector reports matched categories and phrases; the model supplies a MALICIOUS score. Results carry detector source, confidence, matched patterns, and per-chunk explanations for the UI. The response also contains preprocessing and chunking metadata, feature evidence, a final rationale, classifier mode, and model precision.

The five rule categories in backend-node/src/core/securityConstants.ts are override_instructions, jailbreak_attempt, hidden_instruction, system_prompt_reveal, and data_exfiltration. RuleBasedDetectorService uses whole-word matching at alphanumeric term boundaries. Common short or ambiguous terms, including dan, jailbreak, and upload to, require nearby instruction-like wording before they count; the proximity window is 160 characters.

The ONNX model loader reads the local fp32 model from MODEL_DIR through @huggingface/transformers and onnxruntime-node. Remote model loading is disabled. If the model cannot load, the service reports rule_based_fallback and continues with rules. If an already-loaded model throws during inference, the classifier marks those chunks malicious and records an error instead of treating them as clean.

CLASSIFIER_THRESHOLD determines the medium/high risk label boundary; DL_MALICIOUS_THRESHOLD determines when the model flags a chunk. The security endpoints store their analysis results in the in-memory securityEventStore. The /llm/chat final check calls the classifier directly and does not create an analyzeText event.

## Chapter 8 — Manual Webpage Scan and Report

The toolbar Scan action is implemented in App.tsx. It asks the active BrowserWebView handle to capture its guest page through security:scan-webview, sends the captured object to POST /security/check-webpage, and opens the webpage analysis drawer. Prompt analysis and webpage analysis have separate renderer state so their results are not mixed.

The backend classifies these 13 content channels when nonempty: visible_text, hidden_text, html_comments, meta_tags, input_values, aria_text, iframe_content, shadow_dom_content, inline_javascript, css_content, css_generated_content, external_javascript, and source_maps. It preserves the channel name on each chunk so the report can identify where a finding came from. page_title and url accompany the capture but are not among the classified channels. The captured dom_snapshot_content is also not classified.

The manual scan produces a report for the user. It does not automatically stop ordinary browser navigation or automatically scan every page load. Capture and classification happen when the user invokes Scan.

## Chapter 9 — AI Chat

AiAssistantSidebar.tsx provides chat sessions and Agent Mode in the same sidebar. Chat sessions, including their messages, are stored in renderer localStorage. A user can optionally attach the active page; the sidebar then captures the page and passes its visible_text, title, and URL as chat context. It can also send user-selected attachments and up to the recent chat history.

On chat submission, the sidebar calls POST /security/check-prompt for the user's typed prompt. It calls POST /llm/chat only if that response allows the prompt. /llm/chat classifies the prompt again and rejects a malicious result with HTTP 403 before forwarding. llmProviderManager builds a provider message from its system instruction, recent history, optional page context, attachments, and the user request. With no active provider, chat returns an explicit no-provider response; Agent Mode planning instead returns unavailable.

The current checks cover the prompt field. The attached page text, prior history, and file attachments are not individually passed through the webpage or prompt scanner on this chat path. The final /llm/chat check also classifies only the prompt field. A manual Scan result does not become an automatic chat authorization gate.

## Chapter 10 — Autonomous Agent Mode

AgentModePanel starts AgentTask in frontend/src/services/agentRuntimeCore.ts for the active guest target. On each planning round, AgentTask extracts a semantic page state, updates working memory, and calls POST /agent/plan. The backend planner builds a request for the active AI provider, parses the response, validates tool names and arguments against agentToolRegistry, and returns an action queue with confidence and approval metadata. An unconfigured provider yields HTTP 503; invalid plans yield HTTP 422.

The registered planner tools are click, fill, type, press_key, navigate, open_tab, scroll, upload, wait, extract, and finish. The frontend maps browser actions to the runtime contract. It handles open_tab, extract, and finish in the loop itself. Each queued action counts toward the default 150-step limit. After an action, the loop uses runtime verification, records progress or failure, and replans when a target is stale, disabled, nonresponsive, or repeated without progress. It can also retry transient planner failures, stop on cancellation, or end when the planner calls finish.

The frontend approval policy can pause for an upload, a sensitive action, or low-confidence planning. File upload has an additional main-process file picker. AgentBrowserMemory stores origin visits and successful interaction hints in localStorage and can mark an origin blocked. AgentTask checks that blocked-origin memory before planned navigate or open_tab actions.

The approval policy reads accessible control labels for purchase/payment, deletion, and submit-like actions. It also applies tool-specific confidence thresholds: scroll, wait, and extract have a zero threshold; actions such as click, navigate, and finish require higher confidence. A declined approval ends the task. The backend tool registry rejects unknown tools, unsupported URL schemes, invented element IDs, and invalid action queues before returning a plan.

There is agent-specific scanning code in frontend/src/services/agentSecurityPipeline.ts, a runtime security-snapshot command, and backend-node/src/services/agentSecurityService.ts. The current AgentTask.run loop does not call that pipeline. /agent/plan does not scan the supplied page state. Therefore Agent Mode currently sends page state to its planner and acts without an automatic prompt-injection scan on each step. The manual Scan action remains available to the user.

## Chapter 11 — AI Providers and Stored Data

The provider settings UI uses frontend/src/services/providerApiClient.ts and the preload provider APIs. In Electron, frontend/electron/providerSecureStore.ts saves provider configurations to provider_settings.json under the app's prompt-defense-browser data directory. It returns masked keys to the UI, keeps the active provider/model selection, and syncs decrypted configurations to the backend. The backend LlmProviderManager holds its active gateway and configured providers in process memory; Electron syncs the saved selection after startup and on relevant setting changes.

Provider gateway implementations cover OpenAI-compatible endpoints, Anthropic, and Gemini. Backend preset metadata and frontend settings support the configured variants of those gateway families. The backend exposes candidate model fetching and connection tests. Chat and planning use the active gateway; the backend does not persist provider settings to its own file.

ProviderSecureStore uses Electron safeStorage encryption when the operating system supports it. When it does not, the code stores the key with a b64: Base64 prefix, which is encoding rather than encryption. Outside Electron, providerApiClient has a renderer localStorage fallback. These paths matter when assessing where credentials can reside.

Renderer localStorage also holds bookmarks, assistant width, chat sessions, and origin-based agent browser memory. Security events and the backend's provider state are in memory and do not survive a backend restart on their own.

## Chapter 12 — Implemented Security Boundaries and Limits

The app window has context isolation and sandboxing. electronSecurityConfig.ts prevents the app window from navigating away from its trusted development or packaged URL, denies new windows from that window, and adds nosniff and no-referrer response headers. Guest pages are held in separate WebContentsViews. The preload exposes explicit operations rather than Node.js itself, and main validates app-window origin for tab/runtime requests. The app bridge does include a browser:execute-javascript operation for a known guest tab; it should be treated as a privileged app-renderer capability.

The detection gate applies to the submitted chat prompt, and the manual scanner reports captured webpage content. It does not enforce a universal rule that every piece of page or attachment content is scanned before an AI provider sees it. In particular, optional chat page context and Agent Mode page state bypass an automatic injection scan. The 13-channel manual capture is best effort: unavailable frames or failed CDP collection may omit content. A rule-only fallback is weaker than the loaded model, while model inference errors fail closed.

Agent actions are constrained by backend tool validation, registered runtime targets, HTTP(S) navigation validation, frontend approval checks, and the user-driven upload picker. The browser runtime's action verification confirms observed page changes; it is not an injection detector.

## Chapter 13 — Configuration, Build, and Verification

backend-node/src/config/env.ts loads .env values and supplies these defaults:

| Setting | Default | Used for |
| --- | --- | --- |
| APP_NAME | Prompt Injection Defense Browser Backend | Backend display/log name. |
| APP_ENV | development | Runtime environment tag. |
| API_V1_PREFIX | /api/v1 | Fastify route prefix. |
| PORT | 8000 | Backend listening port. |
| CORS_ALLOWED_ORIGINS | http://localhost:5173 | Allowed browser origin for CORS. |
| MODEL_DIR | dl_models/prompt_injection_model | Local Prompt Guard 2 artifact directory. |
| CLASSIFIER_THRESHOLD | 0.7 | Medium/high risk labeling threshold. |
| DL_MALICIOUS_THRESHOLD | 0.5 | Model MALICIOUS decision threshold. |
| DEFAULT_CHUNK_SIZE | 800 | Text chunk size in characters. |
| DEFAULT_CHUNK_OVERLAP | 100 | Overlap between consecutive chunks. |
| AGENT_MIN_CONFIDENCE | 0.6 | Planner confidence threshold for user confirmation. |

From frontend/, npm run dev starts the development processes, npm run build builds backend, Electron, and Vite output, and npm run package invokes electron-builder after building. From backend-node/, npm run dev starts the Fastify TypeScript watcher and npm test runs Vitest. From frontend/, npm run test:e2e runs the Playwright desktop suite and npm run lint runs ESLint. The backend tests cover detection, route behavior, providers, and agent planning/tool validation; the frontend/e2e directory contains app, provider, and Agent Mode suites.
