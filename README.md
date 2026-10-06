<p align="center">
  <img src="frontend/public/favicon.svg" width="96" height="96" alt="Orbit Logo" />
</p>

# Orbit: Agentic AI Browser with Prompt Defense

**Real-Time Prompt Injection Defense in an Autonomous, AI-Native Browser**

**Orbit** is an AI-native desktop web browser engineered to defend against prompt injection attacks in real time. When an AI assistant browses or reads web content on a user's behalf, malicious actors can weaponize web pages with hidden instructions (Indirect Prompt Injection) or supply hostile prompts (Direct Prompt Injection) to manipulate the model.

Orbit implements a multi-stage security pipeline that inspects both user prompts and live web pages across 22 distinct content channels before text can reach a Large Language Model (LLM) or trigger browser automation.

The system is built entirely in TypeScript, pairing an Electron desktop shell and React 19 frontend with a high-performance Fastify 5 security service on Node.js.

---

## Architecture and Process Model

Orbit partitions responsibilities across four isolated operating system and runtime layers:

```
┌─────────────────────────────────┐        IPC (Context Bridge)     ┌────────────────────────────────────┐
│    Renderer Process (React 19)  │◄───────────────────────────────►│    Electron Main Process (Node.js) │
│    frontend/src/                │       window.electronAPI        │    frontend/electron/              │
│                                 │                                 │                                    │
│ - Browser shell UI & tabs       │                                 │ - Native window & lifecycle        │
│ - "Kimo" assistant sidebar      │                                 │ - WebContentsView tab host manager │
│ - Bookmarks toolbar & branding  │                                 │ - CDP Browser Runtime engine       │
│ - Agent Result modal            │                                 │ - Provider credential vault        │
│ - Explainability drawers        │                                 │ - Backend process supervisor       │
│ - Host <div> geometry sync      │                                 │ - Bookmark persistence store       │
└────────────────┬────────────────┘                                 └─────────────────┬──────────────────┘
                 │                                                                    │ Spawns & supervises
                 │ HTTP (Port 8000)                                                   │ (ELECTRON_RUN_AS_NODE=1)
                 │ loopback fetch                                                     │
                 ▼                                                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                          Security Backend Process (Node.js + Fastify 5)                                │
│                          backend-node/                                                                 │
│                                                                                                        │
│ - 22-channel webpage inspection pipeline (14 DOM + 8 telemetry channels)                               │
│ - Dual-Detector Engine: Regex 5-vector pattern matching + Llama Prompt Guard 2 (22M ONNX in fp32)      │
│ - 512-token sliding window safeguards preventing truncation evasion                                    │
│ - Multi-provider LLM gateways (OpenRouter, TokenRouter, Anthropic, Gemini, OpenAI, etc.)               │
│ - Autonomous agent planning service (/api/v1/agent/plan) with multilingual & Roman Urdu goal support   │
│ - Fast, decoupled agent execution via native Chromium CDP input events                                 │
│ - Final guarded chat proxy (/api/v1/llm/chat) with chat history & multimodal attachment support        │
│ - Audit event logging store for security scans                                                         │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘

                                    Sandboxed Guest Page Layer
                                    (Managed by Electron Main)
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 WebContentsView (Chromium Sandbox)                                     │
│ - Native out-of-process web rendering (contextIsolation: true, sandbox: true)                         │
│ - Completely isolated from app DOM, local files, and API credentials                                  │
│ - Inspected and automated exclusively via dedicated Chrome DevTools Protocol (CDP) sessions            │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Process Roles

1. **Electron Main Process**: Oversees application lifecycle, creates native windows, securely stores encrypted API keys via Electron `safeStorage`, manages bookmark persistence, supervises the backend process lifecycle (`backendProcess.ts`), and manages guest tabs using modern `WebContentsView`.
2. **Renderer Process (React 19 UI)**: Drives the browser chrome, navigation toolbar, bookmarks bar, address bar, tabs, and the **Kimo** AI assistant sidebar (Chat and Autonomous Agent modes). Tab surfaces are rendered by tracking container bounds via `ResizeObserver` and synchronizing the native `WebContentsView` position via IPC.
3. **Guest Web View (`WebContentsView`)**: Runs external websites inside an isolated Chromium sandbox. Unlike legacy `<webview>` tags, `WebContentsView` prevents untrusted web code from accessing internal application DOM, local files, or saved credentials.
4. **Security Backend (`backend-node`)**: Fastify 5 microservice on loopback port `8000`. Executes 22-channel inspection, Unicode NFKC normalization, text chunking with boundary overlap, sliding token-window safeguards (512 tokens), dual-detector classification (rule-based regex + Llama Prompt Guard 2 22M transformer in fp32), LLM gateway proxying with chat history and multimodal attachment support, and agent action planning.

---

## Project Structure

```
Prompt_injection_defense_in_AI_Native_Browser/
├── ARCHITECTURE.md                       # Comprehensive architectural specification, security policies, and CDP specs
├── AGENTS.md                             # Agent development guidelines and Graphify/CodeGraph tool instructions
├── CLAUDE.md                             # Repository guidance and developer command workflows
│
├── frontend/                             # Desktop application (Electron + React)
│   ├── electron/                         # Electron Main & Preload scripts
│   │   ├── main.ts                       # App lifecycle, window management, WebContentsView IPC
│   │   ├── preload.ts                    # Hardened contextBridge interface (window.electronAPI)
│   │   ├── backendProcess.ts             # In-process supervision of backend-node
│   │   ├── providerSecureStore.ts        # Encrypted local API key storage (safeStorage)
│   │   ├── bookmarkStore.ts              # Local bookmark management and storage
│   │   ├── webviewContextMenu.ts         # Native context menu and DevTools banner
│   │   ├── cdpInspectionService.ts       # 22-channel snapshot extraction via CDP
│   │   └── browserRuntime/               # Autonomous agent CDP automation engine
│   │       ├── browserRuntime.ts         # CDP command dispatcher and target manager
│   │       ├── nativeInput.ts            # Hardware-level mouse and keyboard event dispatch
│   │       ├── pageInspector.ts          # Accessibility tree (AXTree) parser
│   │       ├── stateBuilder.ts           # Semantic element extraction for agent planner
│   │       ├── verificationEngine.ts     # Pre/post action state validation
│   │       └── waitEngine.ts             # Quiescence and navigation synchronizer
│   ├── src/                              # React 19 UI Application
│   │   ├── App.tsx                       # Welcome screen; lazy-loads the browser shell on start
│   │   ├── components/                   # UI components
│   │   │   ├── BrowserShell.tsx          # Main shell layout, tab manager, drawer state
│   │   │   ├── BrowserWebView.tsx        # Host container synchronizing WebContentsView bounds
│   │   │   ├── BrowserToolbar.tsx        # Navigation controls, address bar, and Scan Page trigger
│   │   │   ├── BookmarkBar.tsx           # Full-featured bookmark toolbar
│   │   │   ├── AiAssistantSidebar.tsx    # Kimo sidebar (Chat and Agent modes)
│   │   │   ├── AgentModePanel.tsx        # Autonomous agent task UI with expandable Result Modal
│   │   │   ├── PromptInputBox.tsx        # Universal prompt input with multimodal attachment staging
│   │   │   ├── PromptModelPicker.tsx     # In-prompt model selection and routing popover
│   │   │   ├── ProviderSettingsModal.tsx # Multi-provider connection & key configuration
│   │   │   ├── WebpageAnalysisDetailsPanel.tsx # 22-channel inspection explainability drawer
│   │   │   ├── PromptAnalysisDetailsPanel.tsx  # Direct prompt analysis explainability drawer
│   │   │   └── KimoMascot.tsx            # Animated Kimo visual identity and mascot
│   │   ├── services/                     # Frontend client services
│   │   │   ├── backendApiClient.ts       # HTTP client for backend security & chat endpoints
│   │   │   ├── agentApiClient.ts         # HTTP client for agent planning & tool catalog
│   │   │   ├── agentRuntimeCore.ts       # Decoupled high-speed agent execution loop with loop & stagnation detection
│   │   │   ├── agentApprovalPolicy.ts    # Risk-weighted confirmation policy with per-tool confidence gating
│   │   │   └── browserMemory.ts          # Agent working memory, per-origin knowledge, and blocklist store
│   │   └── styles/                       # CSS design tokens, layouts, and animations
│   ├── e2e/                              # Playwright integration & E2E tests
│   │   ├── agentMode.spec.ts             # End-to-end agent CDP actions and safety tests
│   │   └── providers.spec.ts             # Multi-provider settings modal verification
│   ├── electron-builder.yml              # Windows NSIS distribution packaging config
│   ├── package.json                      # Frontend scripts and dependencies
│   └── vite.config.ts                    # Vite bundler configuration
│
└── backend-node/                         # Security microservice (Node.js + Fastify 5)
    ├── dl_models/                        # Deep learning model artifacts (Llama Prompt Guard 2)
    │   └── prompt_injection_model/       # 22M DeBERTa-v3-xsmall ONNX model weights and tokenizer
    │       ├── SOURCE.md                 # Model provenance, specs, and SHA-256 verification
    │       ├── config.json               # Architecture config and label mapping (BENIGN / MALICIOUS)
    │       ├── tokenizer.json            # SentencePiece fast tokenizer vocabulary
    │       └── onnx/model.onnx           # fp32 unquantized ONNX model graph (~284 MB)
    ├── src/
    │   ├── server.ts                     # Fastify bootstrap on 127.0.0.1:8000
    │   ├── app.ts                        # Route registration, CORS policy, 422 error handlers
    │   ├── config/                       # Runtime configuration and environment parsing
    │   │   └── env.ts                    # Settings schema and defaults
    │   ├── core/                         # Constants and logger setup
    │   │   ├── securityConstants.ts      # Classification thresholds and pattern categories
    │   │   └── logging.ts                # Pino logging configuration
    │   ├── dl/                           # Deep learning inference engine
    │   │   ├── modelLoader.ts            # Dynamic fp32 ONNX pipeline loader (@huggingface/transformers)
    │   │   └── onnxClassifier.ts         # Batched inference with sliding sub-chunking & 15s timeout
    │   ├── routes/                       # Fastify HTTP endpoint handlers
    │   │   ├── health.routes.ts          # /api/v1/health status, classifier mode, and fp32 precision
    │   │   ├── security.routes.ts        # /api/v1/security/* prompt and 22-channel webpage scanning
    │   │   ├── agent.routes.ts           # /api/v1/agent/plan and /api/v1/agent/tools
    │   │   ├── providers.routes.ts       # /api/v1/providers/* dynamic provider management & models
    │   │   └── llm.routes.ts             # /api/v1/llm/chat guarded chat proxy with history & attachments
    │   ├── schemas/                      # TypeBox contract definitions
    │   │   ├── security.schemas.ts       # Payload schemas for scan requests/verdicts
    │   │   ├── agent.schemas.ts          # Schemas for planner, steps, and AXTree snapshots
    │   │   ├── provider.schemas.ts       # Provider configuration and model schemas
    │   │   └── llm.schemas.ts            # Chat request/response schemas with history/attachments
    │   ├── services/                     # Business logic and detection algorithms
    │   │   ├── ruleBasedDetectorService.ts # Regex detection across 5 attack vectors
    │   │   ├── promptClassifierService.ts  # Dual-detector pipeline coordinator (DL + Rule-based)
    │   │   ├── promptPreprocessingService.ts # Unicode NFKC normalization and HTML stripping
    │   │   ├── textChunkingService.ts    # Sliding window chunker with boundary overlap
    │   │   ├── agentPlannerService.ts    # Multilingual/Roman Urdu goal translation & multi-action planner
    │   │   ├── agentToolRegistry.ts      # Validated catalogue of 11 safe browser tools with queue coherence & order checks
    │   │   ├── securityEventStore.ts     # Scan audit event log store
    │   │   ├── llmProviderManager.ts     # Active provider routing, token tracking, and chat proxy
    │   │   └── llmGateways/              # Provider adapters (OpenAI, Anthropic, Gemini, OpenRouter, etc.)
    │   └── test/                         # Vitest unit and integration test suites
    ├── package.json                      # Backend scripts and dependencies
    └── tsconfig.json                     # Backend TypeScript compiler configuration
```

---

## Core Features

- **Multi-Channel Webpage Inspection (13 Channels)**: Scans 11 core DOM channels (visible text, hidden content, HTML comments, ARIA labels, meta tags, attributes, inputs, iframe content, shadow DOM, inline scripts, styles) plus 2 extended telemetry channels (external scripts, source maps).
- **Dual-Detector Security Pipeline**: Combines high-precision regex detection across 5 distinct attack vectors (role override, jailbreaks, hidden webpage directions, system prompt reveal, exfiltration) with a local deep-learning transformer (`Llama Prompt Guard 2 22M` via ONNX Runtime in full `fp32` precision). Automatic 512-token sliding sub-chunking prevents truncation-based evasion.
- **Decoupled, High-Speed Autonomous Agent**: The autonomous agent loop is engineered for high responsiveness without CPU-bound inference lag on every iteration. Actions are planned directly from Chromium Accessibility Tree (AXTree) semantic states and executed via native CDP hardware-level events.
- **Risk-Weighted Approval Policy**: Enforces tool-specific confidence thresholds rather than a single global cutoff. High-consequence actions (`click`: 70%, `navigate`: 65%, `finish`: 75%) and sensitive transactions (`financial`, `destructive`, `irreversible`: 85%+ or mandatory consent) require strong confidence, whereas harmless actions (`scroll`, `wait`, `extract`) proceed without nuisance user confirmation.
- **Loop & Stagnation Detector**: Inspects action history within a rolling 9-action window. If the agent repeats the identical action 3 or more times on the same page without forward progress, it automatically flags stagnation (`LOOP_DETECTED`) and replans an alternative path.
- **Resilient Side-Page Handling**: Mid-task navigations or redirects to blocked/untrusted origins no longer crash the entire task. The agent records the navigation block in working memory and guides the planner to take an alternative route or continue on the active page.
- **Action Order Sanity Checks**: Validates queue coherence on the backend before execution, catching planner sequence mistakes such as `fill` followed immediately by `navigate` without pressing Enter or submitting, duplicate inputs on the same target, or keypresses immediately following a navigation.
- **Multilingual & Roman Urdu Goal Normalization**: Automatically detects Roman Urdu transliterations and non-English scripts in user goals, performing a lightweight LLM translation normalization pass before planning to ensure accurate element matching and navigation.
- **Agent Result Modal & Task Observability**: Interactive expandable modal in the agent panel enables users to review complete task execution summaries, structured markdown results, and step-by-step logs.
- **Universal Multimodal Attachment Staging**: Chat interface allows users to stage images, PDFs, Word documents (.docx), and text files freely, with real-time model capability detection and friendly warnings if the selected model lacks vision/multimodal support.
- **Chat History & Session Management**: Supports persistent chat conversations and multi-turn message history with session persistence.
- **Orbit Celestial Identity & Bookmarks System**: Orbit branding with celestial planet orbs, particle animations, and a full bookmarking bar with persistence and quick navigation.
- **Hardware-Level CDP Automation**: The agent interacts strictly via native Chromium DevTools Protocol input events (mouse movements, clicks, and keyboard strokes) rather than injected JavaScript DOM methods (`element.click()`).
- **Universal Provider Gateway & In-Prompt Model Picker**: Connect to any OpenAI-compatible provider (OpenRouter, TokenRouter, NaraRouter, NVIDIA NIM, Cloudflare) or native APIs (Google Gemini, Anthropic Claude). Switch models on-the-fly directly inside the prompt box; keys are encrypted locally using Electron `safeStorage`.
- **Explainability & Forensic Drawers**: Complete breakdown of dual-detector verdicts, confidence scores, token counts, linguistic density metrics, and matched evidence patterns for scanned prompts and web pages.

---

## Prerequisites

Before cloning and running Orbit, ensure your system has:

- **Node.js**: Version 20 LTS or newer (includes `npm`).
- **Git**: Recent version for repository cloning.
- **Operating System**: Windows 10/11, macOS, or modern Linux.

---

## How to Clone and Run

### 1. Clone the Repository

```bash
git clone https://github.com/Salmantahir002/Prompt_injection_defense_in_AI_Native_Browser.git
cd Prompt_injection_defense_in_AI_Native_Browser
```

### 2. Set Up and Build the Backend

Navigate to `backend-node`, install dependencies, and build the TypeScript source:

```bash
cd backend-node
npm install
npm run build
```

*(Optional)* Create a `.env` file if you wish to adjust default ports or thresholds:

```bash
# Windows
copy .env.example .env

# macOS / Linux
cp .env.example .env
```

> **Note:** You do not need to put API keys in `.env`. Provider API keys are configured directly inside the browser UI and stored securely by Electron via `safeStorage`.

### 3. Set Up and Launch the Application

Return to the repository root and navigate into `frontend`:

```bash
cd ../frontend
npm install
npm run dev
```

The `npm run dev` script automatically coordinates:
1. The **Fastify backend** on `http://127.0.0.1:8000`.
2. The **Vite dev server** on `http://localhost:5173`.
3. TypeScript compilation of the Electron main and preload scripts.
4. The **Electron browser window**, launched once both HTTP services are responsive.

### 4. Configure an AI Provider

1. Once the browser launches, click the **Kimo** assistant icon in the upper-right corner to expand the sidebar.
2. Click the **Settings** (gear) icon in the assistant header.
3. Select your preferred provider (e.g., **OpenRouter**, **Google Gemini**, **Anthropic**, **OpenAI**, **TokenRouter**, or **Custom**).
4. Enter your API key, select a model, and click **Connect & Activate**.
5. You can now use AI Chat with multimodal attachments and the Autonomous Agent with real-time prompt injection defense.

---

## Additional Run and Build Commands

### Standalone Backend Execution

```bash
# Run Fastify backend in watch mode (tsx)
cd backend-node
npm run dev

# Run compiled backend production entrypoint
cd backend-node
npm start
```

### Testing

```bash
# Backend unit & integration tests (Vitest)
cd backend-node
npm test

# Run a specific backend test suite
cd backend-node
npx vitest run test/ruleBasedDetectorPrecision.test.ts

# Frontend E2E tests (Playwright with real CDP)
cd frontend
npm run test:e2e
```

### Production Build and Packaging

```bash
# Compile both backend and frontend bundles
cd frontend
npm run build

# Package standalone Windows installer (NSIS executable)
cd frontend
npm run package
```

The packaging configuration (`frontend/electron-builder.yml`) bundles the compiled Node backend inside `resources/backend` and runs it using Electron's bundled Node runtime (`ELECTRON_RUN_AS_NODE=1`), requiring zero external Node.js installation on end-user machines. `npm run package` first runs `npm run package:stage` (`frontend/scripts/stage-backend.mjs`), which copies only the backend's production dependencies and this platform's onnxruntime binary into `frontend/build/backend`; that staged copy, not `backend-node/node_modules`, is what ships.

---

## API Reference Summary

All backend endpoints are served under `http://127.0.0.1:8000/api/v1`:

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Service status, classifier mode, model precision (`fp32`), and runtime versions. |
| `POST` | `/security/check-prompt` | Evaluates user prompts for direct injection attacks using the dual-detector pipeline. |
| `POST` | `/security/check-webpage` | Evaluates 22 webpage channels (14 DOM + 8 telemetry) on manual scans. |
| `GET` | `/security/events` | Retrieves audit log history of security scans. |
| `POST` | `/agent/plan` | Normalizes multilingual/Roman Urdu goals, synthesizes page state, and outputs validated tool calls. |
| `GET` | `/agent/tools` | Returns metadata and TypeBox schemas for the 11 permitted agent tools. |
| `GET`/`POST`/`DELETE` | `/providers/active` | Inspects, activates, or disconnects the active LLM provider. |
| `GET` | `/providers/presets` | Lists supported provider templates and gateway URLs. |
| `POST` | `/providers/models` | Fetches available models for a given provider configuration. |
| `POST` | `/providers/test` | Validates API credentials and measures endpoint latency. |
| `POST` | `/llm/chat` | Final guarded proxy for chat with conversation history and multimodal attachments. |

---

## Configuration

Default environment variables in `backend-node/src/config/env.ts`:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `8000` | Loopback port for the Fastify server. |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173` | Allowed origins for browser renderer fetch requests. |
| `MODEL_DIR` | `dl_models/prompt_injection_model` | Directory holding the Llama Prompt Guard 2 artifacts. Absent → rule-based-only fallback. |
| `DL_MALICIOUS_THRESHOLD` | `0.50` | MALICIOUS probability at which the deep-learning detector flags a chunk. |
| `CLASSIFIER_THRESHOLD` | `0.70` | Score threshold above which content is marked malicious. |
| `DEFAULT_CHUNK_SIZE` | `800` | Character count per analysis text chunk. |
| `DEFAULT_CHUNK_OVERLAP` | `100` | Boundary overlap between adjacent chunks. |
| `AGENT_MIN_CONFIDENCE` | `0.60` | Confidence threshold below which agent prompts user confirmation. |
