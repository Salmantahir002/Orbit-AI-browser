# PromptGuard backend migration — FastAPI → Fastify/TypeScript

Tracks the staged port of `backend/` (Python) to `backend-node/` (Node). Parity
was verified (prompt §28) and the Python `backend/` tree has been **removed** —
`backend-node/` is now the only backend.

> **Later change (2026-09-29): agent-mode scanning was removed.** Phase 3's agent
> security slice no longer exists: `agentSecurityService.ts`,
> `agentSecurityEventStore.ts`, the `AgentPageSnapshot`/`AgentScanRequest`/
> `AgentScanResponse` schemas, `POST /agent/scan-active-page`, and
> `GET /agent/security/events` (plus the frontend `agentSecurityPipeline`). Agent mode
> has no prompt-injection scan; only the manual Scan Page path does. The mentions of
> those pieces below are history, kept for the parity record.

## Phase plan

| Phase | Scope | Status |
|-------|-------|--------|
| **1** | Baseline, Fastify skeleton, shared contracts, security-service unit tests | **done** |
| **2** | Security detection full parity: `check-webpage` channel model (extended past 14), `/security/events`, aggregation + fail-closed | **done** |
| **3** | Agent services, non-LLM slice: tool registry, agent security service + isolated event store, `/agent/scan-active-page`, `/agent/security/events`, `/agent/tools` | **done** |
| **4** | Agent planner (LLM-backed, `/agent/plan`) + LLM gateway (OpenAI-compatible / Anthropic / Gemini + 8 presets) + provider system (`/providers/*`) + `/llm/chat` + ONNX ML service scaffold with rule-based fallback | **done** |
| **5** | Electron cutover, crawler/Playwright removal, packaging, docs | **done** |
| **5 (Stage 7)** | Remove Python `backend/` tree (64 tracked files + local `.venv`/`.env`); carry the real OpenCode Zen key/model into `backend-node/.env` | **done** |
| **5.5** | Full e2e pass ✅ (16/16); CDP MCP browser smoke test ✅ (Chrome DevTools MCP → live Fastify :8000, 15/15 endpoints, real CORS, real OpenCode Zen round-trip); one defect found + fixed (validation errors → 500, now 422); migration report ✅ | **done** |

## API compatibility table

Base path `/api/v1` is preserved. Request/response shapes are field-for-field
ports of the Pydantic models. `4xx` bodies keep FastAPI's `{"detail": "..."}` shape
(`schemas/common.ts` → `ErrorResponseSchema`), including request-schema violations
(`422`) and unknown routes (`404`), normalized by the `setErrorHandler` /
`setNotFoundHandler` in `app.ts` (added in Phase 5.5).

| Method | Path | Frontend caller | Python source | Node route | Phase | Status |
|--------|------|-----------------|---------------|------------|-------|--------|
| GET | `/health` | `backendApiClient.getHealth` | `health_routes.py` | `routes/health.routes.ts` | 1 | ✅ ported |
| POST | `/security/check-prompt` | `backendApiClient.checkPrompt` | `security_routes.py` | `routes/security.routes.ts` | 1 | ✅ ported |
| POST | `/security/check-webpage` | `backendApiClient.checkWebpage` | `security_routes.py` | `routes/security.routes.ts` | 1, extended in 2 | ✅ ported + enhanced |
| GET | `/security/events` | `backendApiClient.getSecurityEvents` | `security_routes.py` | `routes/security.routes.ts` | 1 | ✅ ported |
| POST | `/llm/chat` | `backendApiClient.chatWithLlm` | `llm_routes.py` | `routes/llm.routes.ts` | 4 | ✅ ported |
| POST | `/agent/plan` | `agentApiClient.requestPlan` | `agent_routes.py` | `routes/agent.routes.ts` | 4 | ✅ ported |
| POST | `/agent/scan-active-page` | `agentSecurityPipeline` | `agent_routes.py` | `routes/agent.routes.ts` | 3 | ✅ ported, later removed |
| GET | `/agent/security/events` | — (no frontend caller found) | `agent_routes.py` | `routes/agent.routes.ts` | 3 | ✅ ported, later removed |
| GET | `/agent/tools` | — (no frontend caller found) | `agent_routes.py` | `routes/agent.routes.ts` | 3 | ✅ ported |
| GET/POST/DELETE | `/providers/active` | `providerApiClient` | `provider_routes.py` | `routes/providers.routes.ts` | 4 | ✅ ported |
| GET | `/providers/presets` | `providerApiClient.getProviderPresets` | `provider_routes.py` | `routes/providers.routes.ts` | 4 | ✅ ported |
| POST | `/providers/models` | `providerApiClient.fetchProviderModels` | `provider_routes.py` | `routes/providers.routes.ts` | 4 | ✅ ported |
| POST | `/providers/test` | `providerApiClient.testProviderConnection` | `provider_routes.py` | `routes/providers.routes.ts` | 4 | ✅ ported |
| POST | `/crawler/render-url` | **none found** in `frontend/` | ~~`crawler_routes.py`~~ | — | 5 | ✅ removed (route + service + schema + `playwright` dep) |

### Health response note

Frontend `HealthResponse` (`securityTypes.ts`) reads only `status`, `version`,
`model_loaded` — all preserved. The Node route additionally returns
`classifier_mode` and `runtime: { node, node_implementation, fastify, platform }`
in place of Python's `runtime: { python, fastapi, uvicorn, ... }`. The only reader
of `runtime.*` is `frontend/electron/webviewContextMenu.ts` (a DevTools console
banner) — updated in Phase 5 at cutover.

### Schema-default note

Pydantic fills field defaults on construction; TypeBox `Value.Check` does not.
`analyzeText()` always builds `ChunkResult` objects complete (`source`,
`matched_evidence`), so this is not observable on the wire. Tests build complete
objects for the same reason.

## Phase 2: channel model, extended past 14

`MANUAL_SCAN_CHANNELS` (`routes/security.routes.ts`) now scans **22 channels**,
not the original 14. This is a deliberate Node-only enhancement (deviates from
strict Python parity by design, per explicit request):

- `CORE_CHANNELS` — the original 14, byte-for-byte identical to
  `security_routes.py::MANUAL_SCAN_CHANNELS` / `agent_routes.py::AGENT_SCAN_CHANNELS`.
- `EXTENDED_CHANNELS` — 8 more: `external_javascript`, `source_maps`, `redirects`,
  `third_party_resources`, `suspicious_domains`, `frame_navigation`,
  `runtime_script_activity`, `loaded_resources`.

Why this was free to add: `cdpInspectionService.ts` (Electron, unchanged) has
always captured and sent all 8 in every `check-webpage` request, and
`WebpageCheckRequestSchema` already declared them as optional fields — they were
captured, transmitted, and accepted, just never classified. Wiring them into
`MANUAL_SCAN_CHANNELS` needed no frontend, schema, or capture-layer change, only
the route's channel list. They carry structured telemetry (URLs, hostnames,
console/script dumps) rather than free prose, so the existing rule-based phrase
matcher has little surface to false-positive on, while an injection smuggled
into a redirect chain, an external script URL, or console/exception output is
now caught instead of silently skipped. `dom_snapshot_content` is still
deliberately excluded — see the comment in `security.routes.ts` and
`test_agent_and_manual_scan_agree.py` for the false-positive incident that
excluded it.

**Phase 3 obligation — fulfilled:** `agent.routes.ts`'s `AGENT_SCAN_CHANNELS` is
a direct re-export of this `MANUAL_SCAN_CHANNELS`, not a separately-declared
copy — see "Phase 3 changes" below.

## Baseline

- **Node backend:** `npm run build` (tsc) clean; `npm test` → 178/178 passing
  (vitest, 15 files): 47 from Phase 1 + `webpageSecurityRoute.test.ts` (9) +
  `ruleBasedDetectorPrecision.test.ts` (21) from Phase 2 +
  `agentSecurityRoute.test.ts` (17), `agentToolRegistry.test.ts` (20),
  `agentToolQueue.test.ts` (17: 14 + the 3 end-to-end planner tests unblocked
  in Phase 4) from Phase 3 + `providerGateways.test.ts` (7),
  `providerRoutes.test.ts` (5), `llmRoutes.test.ts` (3),
  `agentPlannerService.test.ts` (21), `agentRoutes.test.ts` (11) from Phase 4.
- `vitest.config.ts` added in Phase 4: `pool: 'forks'`, `singleFork: true`. The
  five new route suites each spin up a full Fastify instance; running every
  suite in parallel worker threads exhausted this environment's V8 heap
  ("Committing semi space failed") and killed a sibling suite mid-run. One
  fork runs the whole suite in ~3s, deterministically.
- **Python backend baseline was never captured** — no venv with FastAPI was
  installed on this machine at any point (`backend/.venv` absent; root `.venv`
  lacked deps). The vitest suites were written as 1:1 ports of the Python test
  assertions (`test_rule_based_detector_service.py`, `test_text_chunking_service.py`,
  `test_prompt_classifier_service.py`, `test_analysis_details_schema.py`,
  `test_webpage_security_route.py`, `test_agent_*`, `test_provider_*`,
  `test_llm_routes.py`), so the ported assertions themselves are the parity
  record. The Python `backend/` tree has since been removed (Stage 7); its source
  remains in git history at the pre-removal commit for anyone wanting to diff.

## Phase 1 changes

- `src/routes/health.routes.ts` — wired `model_loaded`/`classifier_mode` to the real
  `promptClassifier` (were hardcoded).
- `src/schemas/common.ts` — new `ErrorResponseSchema` (`{ detail }`), shared 4xx body.
- `src/routes/security.routes.ts` — declared `400` responses with `ErrorResponseSchema`
  (fixes a pre-existing `tsc` error where `reply.code(400)` clashed with a 200-only
  response schema).
- `tsconfig.json` — exclude `src/**/*.test.ts` from the build.
- `test/` — vitest suites + `test/fixtures/{safe,malicious}_prompts.json` copied from
  `backend/app/test_data/` (self-contained so they survive Python-backend removal).

## Phase 2 changes

- `src/routes/security.routes.ts` — `MANUAL_SCAN_CHANNELS` split into
  `CORE_CHANNELS` (14, unchanged) + `EXTENDED_CHANNELS` (8, new) — see "channel
  model, extended past 14" above. No schema changes needed (fields already
  optional in `WebpageCheckRequestSchema`); no frontend changes needed
  (`cdpInspectionService.ts` already sends them).
- `test/webpageSecurityRoute.test.ts` — new, ports `test_webpage_security_route.py`
  (5 tests) + 4 new tests covering the extended channels and the
  `dom_snapshot_content` exclusion.
- `test/ruleBasedDetectorPrecision.test.ts` — new, ports the detector-precision
  half of `test_agent_and_manual_scan_agree.py` (20 tests: false-positive guards,
  weak-term corroboration, proximity window, word boundaries) plus 2 channel-list
  invariant checks. The agent-verdict half stays a Phase 3 TODO — `agent_routes.py`
  isn't ported yet.

## Phase 3 changes — agent services (non-LLM slice)

`agent_planner_service.py` (and therefore `/agent/plan`) depends on
`llm_provider_manager`, which is Phase 4 work — porting it now would mean
porting Phase 4 early under a different name. Everything else in the agent
subsystem has no LLM dependency and ports cleanly on its own, so Phase 3 was
split along that real dependency boundary instead of the original doc split:

- `src/services/agentToolRegistry.ts` — full port of `agent_tool_registry.py`:
  the 11 `TOOL_SPECS`, `registerTool`/`allTools`/`requiresApproval`,
  `renderToolCatalogue` (planner-prompt doc, reused unchanged by Phase 4),
  `validateToolCall`/`validateToolQueue` (URL-scheme allowlist, element-id
  existence checks, queue rules: nothing after `finish`, no element-dependent
  tool after `navigate`, approval tools must be solo).
- `src/services/agentSecurityService.ts` — full port of `agent_security_service.py`.
  Deliberately does not import anything from `security.routes.ts` — same
  detection primitives (`chunkingService`, `promptClassifier`), separate
  aggregation/wording, so the two verdict pipelines stay independently editable.
- `src/services/agentSecurityEventStore.ts` — full port of
  `agent_security_event_store.py`; a separate in-memory store from
  `securityEventStore.ts` by design (endpoint isolation, both directions).
- `src/schemas/agent.schemas.ts` — `AgentPageSnapshot`/`AgentScanRequest`/
  `AgentScanResponse` only. `AgentPlanRequest`/`AgentPlanResponse` and the
  working-memory/page-state schemas are added in Phase 4 alongside the code
  that actually consumes them.
- `src/routes/agent.routes.ts` — `POST /agent/scan-active-page`,
  `GET /agent/security/events`, `GET /agent/tools`. **`AGENT_SCAN_CHANNELS` is
  a direct re-export of `MANUAL_SCAN_CHANNELS`** from `security.routes.ts`,
  not a separately-declared "identical" tuple — this makes the two scanners
  drifting apart a compile-time impossibility rather than something only a
  test catches (stronger than the Python original, which pins the equality
  with `test_the_two_scanners_read_the_same_channels` because the two tuples
  are independently typed out). Both scanners therefore already scan the full
  22-channel Phase 2 list, including the extended channels.
- `test/agentSecurityRoute.test.ts` — ports `test_agent_security_route.py`
  (12 tests): clean-page allow, every covert channel, hidden-channel emphasis
  wording, empty-snapshot fail-closed, missing-task_id rejection, event
  logging + task filtering, and both directions of manual/agent log isolation.
- `test/agentToolRegistry.test.ts` + `test/agentToolQueue.test.ts` — port
  `test_agent_tool_registry.py` (16 tests) and the non-LLM slice of
  `test_agent_tool_queue.py` (12 tests: queue rules, dangerous-tool exclusion,
  runtime tool registration, `/agent/tools` metadata). The 3 end-to-end tests
  in `test_agent_tool_queue.py` that mock the planner's `_call_model` are
  deferred to Phase 4 with `/agent/plan` itself.

## Phase 4 changes — LLM gateway, provider system, planner, ONNX scaffold

### LLM gateway (`src/services/llmGateways/`)

- `base.ts` — `ProviderType`, `ModelInfo`, `ProviderConfig`, `ChatUsage`,
  `ChatResult`, abstract `ProviderGateway`. Port of `llm_gateways/base.py`.
  `defaultProviderConfig()` helper fills the field defaults Pydantic gave for
  free (used by tests and the route config builder).
- `openaiCompatible.ts` / `anthropic.ts` / `gemini.ts` — full ports of
  `openai_compat.py` / `anthropic_gateway.py` / `gemini_gateway.py`. `httpx`
  → the global `fetch`; retry/backoff on 429/503/529/504, Cloudflare model
  search + curated fallback list, AgentRouter Stainless header fingerprint,
  provider-specific auth (Bearer / `x-api-key` / `?key=`). `ChatResult` drops
  the `finish_reason`/`raw` kwargs `openai_compat.py` passes but its own
  `ChatResult` model silently ignores (Pydantic `extra="ignore"` default) —
  they were never on the wire.
- `factory.ts` — `PROVIDER_PRESETS` (the 8, same order:
  opencode/gemini/anthropic/openai/nvidia/agentrouter/cloudflare/custom) and
  `createGateway()` (anthropic/gemini by type-or-id, everything else →
  OpenAI-compatible).

### Provider manager + services

- `src/services/llmProviderManager.ts` — port of `llm_provider_manager.py`:
  active-provider state, `listModelsForConfig`, `testConnection` (latency +
  model count), `chat` (Kimo system prompt, webpage grounding, 25k content
  cap, provider-error → in-band error response), `planChat` (raw string for
  the agent planner; throws if no provider active). Class is exported (not
  just the singleton) so tests can instantiate a clean one.
- `src/services/llmOpenCodeZenService.ts` — thin proxy in front of the
  provider manager, kept because `llm_routes.py` imports it by that name
  (the Python name is historical — it is provider-agnostic).

### Routes

- `src/routes/providers.routes.ts` — `/providers/presets`, `/providers/models`
  (400 on empty key), `/providers/test`, `GET|POST|DELETE /providers/active`.
  Key masking (`abcd••••wxyz`) ported from `provider_routes.py::_mask_key`.
  Gateway failures on `/providers/models` all surface as 400 (Python splits
  `ValueError`→400 / other→500, but every gateway raises the equivalent of a
  deliberate `ValueError`; there is no reliable class distinction on this side).
- `src/routes/llm.routes.ts` — `POST /llm/chat`: empty-prompt 400, final
  malicious-prompt safety gate (403), then forward with optional page context.
- `src/routes/agent.routes.ts` — `POST /agent/plan` added: empty-goal 400,
  not-configured 503, `ToolValidationError`→422 (recoverable replan, not an
  outage), other provider errors→502, else the validated tool call(s) plus
  `confidence`, `needs_user_confirmation` (< `AGENT_MIN_CONFIDENCE`), `model`,
  `planner_mode: "llm"`.

### Planner

- `src/services/agentPlannerService.ts` — full port of
  `agent_planner_service.py`: the verbatim `PLANNER_SYSTEM_PROMPT` (quiz/filter/
  search guidance + the untrusted-page-content security rule), `renderPageState`
  / `renderWorkingMemory` (element flags, `near=` printed once per block,
  bounded to 450 elements / 12 completed / 5 failures), the brace-tracking
  `extractJsonObject` (survives markdown fences, surrounding prose, braces and
  escaped quotes inside string values), single-action ↔ queue coalescing,
  confidence clamp + `bool`/non-number → 0.5. `_call_model` → private
  `callModel` (tests spy on it).
- `src/schemas/agent.schemas.ts` — the planner half added:
  `AgentSemanticElement`/`Dialog`/`ValidationIssue`, `AgentPageState`,
  `AgentStepRecord`/`FailureRecord`, `AgentWorkingMemory`, `AgentPlanRequest`,
  `AgentToolCall`, `AgentPlanResponse`.

### ONNX ML — scaffold only, dormant by design

The migration prompt asks for "ONNX Runtime for ML with rule-based fallback".
No trained model artifact exists in this repo, and the project's standing
decision is to leave it uninstalled until explicitly asked (see the
`promptguard-pending-hybrid-detector` memory), so this ships as a real but
dormant path:

> **Superseded.** The dormant sklearn path described below was deleted and
> replaced by `src/dl/`, which loads Llama Prompt Guard 2 (mDeBERTa-v3, fp32
> ONNX) and runs *alongside* the rule-based detector on every chunk rather than
> instead of it. See ARCHITECTURE.md §7. Kept here as a record of what the
> migration originally shipped.

- `src/ml/modelLoader.ts` — looks for `prompt_injection_pipeline.onnx`
  (+ optional `model_metadata.json`) under `settings.MODEL_DIR`; if absent,
  returns `null` and the classifier stays on the rule-based detector — exactly
  `prompt_classifier_service.py`'s behavior when `MODEL_DIR` has no model
  files. `onnxruntime-node` is loaded through a **non-literal dynamic import**
  so tsc never needs its declarations and a missing native binary cannot crash
  startup.
- `src/ml/onnxClassifier.ts` — reshapes an ONNX pipeline's output into the
  detector contract; reads the session's own declared input/output names
  rather than guessing; runs the rule-based detector alongside purely to
  supply `matched_patterns`/`pattern_evidence` for the explainability drawer
  (the "hybrid" design the memory pre-approved — built correct from the start
  here since there is no prior Node behavior to preserve). Any unrecognized
  output shape throws and the caller falls back, mirroring
  `_classify_with_model`'s broad `except`.
- `onnxruntime-node` is in `package.json` `optionalDependencies` (NOT
  installed here: it needs a postinstall script this sandbox blocks, and
  installing it also churned `node_modules` enough to break the vitest
  toolchain — see the git-clean note). Enabling real inference is a
  follow-up: allow its postinstall, drop in a converted `.onnx` pipeline,
  done — no code change.
- **`promptClassifier.classify()` is now `async`.** ONNX inference in
  onnxruntime-node has no sync API, so the hot path had to become async.
  Rippled to: `analyzeText` (`security.routes.ts`), `AgentSecurityService.
  scanSources`, `/llm/chat`, and `test/promptClassifierService.test.ts` — all
  mechanical `await` additions; the three consumers were already inside async
  handlers. `modelLoaded`/`classifierMode` still report `false`/
  `rule_based_fallback` (no model present), unchanged on the wire.

## Phase 5 changes — Electron cutover, crawler removal, packaging, docs

### Frontend → Node backend cutover

- `frontend/package.json` scripts:
  - `backend` → `npm --prefix ../backend-node run dev` (was the Python
    `.venv\Scripts\python.exe run_backend.py`). `tsx watch`, port 8000.
  - added `backend:prod` (`node ../backend-node/dist/server.js`),
    `backend:build` (`npm --prefix ../backend-node run build`).
  - `build` now runs `backend:build` first, so every frontend build produces a
    fresh `backend-node/dist`.
  - `electron:start` uses `backend:prod`; added `package` / `package:dir`
    (electron-builder).
- **No frontend source change for the API URL.** All three HTTP clients
  (`backendApiClient.ts`, `agentApiClient.ts`, `providerApiClient.ts`) already
  hardcode `http://127.0.0.1:8000/api/v1`, and the Node backend binds the same
  host/port — the cutover is transparent to the renderer (prompt §4).
- `frontend/electron/webviewContextMenu.ts` — the DevTools version banner now
  reads the Node health shape (`runtime.{node,node_implementation,fastify,
  platform}`) instead of `{python,python_implementation,fastapi,uvicorn}`. This
  is the only reader of `health.runtime.*`.

### Production backend lifecycle — `frontend/electron/backendProcess.ts` (new)

`npm run dev` starts the backend through its `concurrently` script, but the
packaged app and the Playwright e2e harness both launch `dist-electron/main.js`
directly with no such wrapper. `backendProcess.ts` fills that gap:

- `startBackend()` — no-op when `PROMPT_DEFENSE_DEV=true` (concurrently owns the
  port); otherwise `spawn(process.execPath, [entry], { env: { ELECTRON_RUN_AS_NODE:
  '1', APP_ENV: 'production', PORT: '8000' } })` — Electron's bundled Node runs
  the backend, so the installed app needs **no system Node**. Entry resolves to
  `resources/backend/dist/server.js` when packaged, else
  `../../backend-node/dist/server.js`. Then polls `/api/v1/health` for ≤15 s;
  best-effort (logs and continues on failure — the renderer already degrades
  gracefully, and the e2e UI/CDP suites don't need the backend).
- `stopBackend()` — `child.kill()` on `app` `will-quit`. No orphaned process
  (prompt §24).
- Wired into `main.ts`: `await startBackend()` before `createWindow()` in
  `app.whenReady`; `stopBackend()` on `will-quit`.

### electron-builder packaging — `frontend/electron-builder.yml` (new)

The `build` key in `package.json` is an npm script, so electron-builder is
configured from a YAML file. `appId com.promptguard.browser`, NSIS target
(`oneClick:false`, dir-selectable). The compiled Node backend ships as an
**unpacked resource**: `extraResources` copies `backend-node/{dist,node_modules,
package.json}` → `resources/backend/`. `asar:true` for the Electron app itself.
Known manual step: run `npm ci --omit=dev` in `backend-node/` before `npm run
package` for a lean installer (tsx / vitest / esbuild are devDependencies and
would otherwise be copied). Installer build + clean-Windows-machine test is a
manual step — not runnable in this environment.

### Crawler / Playwright removal (Python side)

Confirmed zero callers (frontend, tests, scripts). Removed:
`backend/app/api/v1/crawler_routes.py`,
`backend/app/services/playwright_crawler_service.py`,
`backend/app/schemas/crawler_schemas.py` (+ `__pycache__`); the two
`api_router.py` lines; `playwright` from `backend/requirements.txt`.
`webpage_parser_service.py` never imported Playwright, so it is untouched. The
Node backend never had a crawler route.

### Docs

- `README.md` — intro + migration callout, Technology Stack table, DevTools
  banner bullet, request-flow diagram label, Prerequisites (Python now
  "optional"), Getting Started (backend-node setup, run modes, `npm run
  package`), repo tree (`backend-node/` added, crawler files gone), API
  reference (crawler row removed, `/providers/*` row added, Swagger note
  dropped — Fastify serves no `/docs`), Configuration (`env.ts` path, `PORT`),
  Testing (Vitest).
- `ARCHITECTURE.md` — migration banner after the intro; §2 intro + §2.1
  Technology table + §2.2 first rows rewritten to Node/Fastify with *(was …)*
  annotations; §3 intro count 16→15; §3.1 health `runtime` example; §3.10
  marked **REMOVED** (number retained); §3.12 quick-ref row 10 struck through;
  §10 diagram label; §11 tooling table + dependency-pins paragraph. Sections
  2–3 still describe the Python implementation in detail — a full rewrite
  (renumbering, diagrams) is deferred to the Python-removal step; the banner
  points readers to this file as authoritative.
- `docs/AGENT_ARCHITECTURE.md` — Testing block (Vitest, 178) + migration note.

### Stage 7 — Python `backend/` removed

Done after e2e went green (16/16) against the Node cutover.

- `git rm -rf backend/` — 64 tracked files (routes, services, schemas, tests,
  `test_data/`, `requirements.txt`, `run_backend.py`, `.env.example`), then
  `rm -rf backend/` for the untracked local `.venv/` and `.env`. Source stays
  recoverable from git history at the pre-removal commit.
- **Credentials carried over first:** the local `backend/.env` held the real
  `OPENCODE_ZEN_API_KEY` + `OPENCODE_ZEN_MODEL` (`mimo-v2.5-free`) while
  `backend-node/.env` still had placeholders. Copied both real values into
  `backend-node/.env` (git-ignored there, as it was in `backend/`) so live chat
  and agent planning keep working unchanged.
- Doc references to `backend/` updated to past tense / repointed to
  `backend-node/` paths: `README.md` (migration callout, repo tree, testing
  section, ML-artifact path, troubleshooting rows), `ARCHITECTURE.md` (banner,
  §7.1/§7.2 ML model path → ONNX under `backend-node/`, §11 pins paragraph),
  `docs/AGENT_ARCHITECTURE.md` (agent-services table → `.ts` paths, testing
  note).
- **`ARCHITECTURE.tex`** (a stale LaTeX export of an older `ARCHITECTURE.md`) is
  left as-is — it is not a live doc; regenerate or delete it separately.
- `u:\FYP_first\CLAUDE.md` (outside this git repo, parent dir) still describes
  the old `backend/` layout — out of scope for this repo's migration; update it
  when convenient.

### Stage 8 — OpenCode Zen dropped as the default provider

- `backend-node/.env` / `.env.example` — the `OPENCODE_ZEN_*` block (API key, base
  URL, model, verify-SSL) was **removed**. The backend `.env` now carries **no
  provider credentials at all**; every provider is connected at runtime from the
  Settings screen with the user's own API key and synced via
  `POST /api/v1/providers/active`.
- `src/config/env.ts` — the four `OPENCODE_ZEN_*` fields (and the now-unused
  `parseBool` helper) were dropped from `Settings` / `settings`. Nothing read them
  at runtime — `llmProviderManager` starts with no active provider.
- `src/routes/agent.routes.ts` — the 503 "planner unavailable" body no longer
  names `OPENCODE_ZEN_API_KEY` / `backend/.env`; it now says "no LLM provider is
  active. Connect and activate a provider in Settings." `test/agentRoutes.test.ts`
  updated to match.
- **OpenCode Zen is still a first-class provider** — it stays in
  `PROVIDER_PRESETS` (`factory.ts`), the frontend preset list, the model picker,
  and `llmOpenCodeZenService.ts`. It is just no longer special-cased or seeded
  from env.
- `src/ml/modelLoader.ts` now also accepts `prompt_injection_model.onnx` (the name
  used in the architecture diagram) alongside `prompt_injection_pipeline.onnx`.
- `ARCHITECTURE.md` and `ARCHITECTURE.tex` backend sections rebased onto the Node
  stack (Fastify/TypeScript/TypeBox/cheerio/ONNX Runtime/Vitest), `.ts` file
  paths, the removed crawler endpoint, and the Node `/health` runtime shape.

### Still open

- electron-builder installer build + clean-Windows-machine validation — manual
  (native download / signing; not runnable here).
- ~~Real ONNX inference~~ — **done.** `onnxruntime-node`'s postinstall was
  approved and `src/dl/` now runs Llama Prompt Guard 2 (fp32) layered with the
  rule-based detector. See ARCHITECTURE.md §7.

### Phase 5.5 — full e2e pass + CDP MCP browser smoke test

Run 2026-09-01. Chrome DevTools MCP driving a real Chromium at
`http://localhost:5173` (the Vite-served renderer) against the migrated Fastify
backend on `127.0.0.1:8000` — genuine cross-origin requests exercising the CORS
allowlist.

- **e2e** — `frontend` `npm run test:e2e`: **16/16** (real-CDP Browser Runtime +
  agent-mode UI + startup/toolbar).
- **Vitest** — `backend-node` `npm test`: **178/178** (after the error-handler fix
  below).
- **Browser smoke — 15/15 endpoints** hit through the page's `fetch`:
  - CORS headers correct on every response (`access-control-allow-origin:
    http://localhost:5173`, `credentials: true`, `vary: Origin`); allowlist enforced.
  - Detection: benign allowed; direct injection blocked (`override_instructions`);
    webpage injection blocked (`jailbreak_attempt` + `override_instructions` +
    `system_prompt_reveal`); agent-scan injection blocked (`data_exfiltration`).
  - Fail-closed: empty webpage snapshot → 400; empty agent snapshot → 400;
    missing `task_id` → 400.
  - **Endpoint isolation confirmed live**: after a manual webpage scan and an
    agent scan in the same session, `GET /security/events` held only
    `direct_prompt` + `webpage_content` events and `GET /agent/security/events`
    held only the agent scans (`origin: agent_runtime`) — separate stores, no
    cross-contamination.
  - Providers: `presets` (8), `POST/GET/DELETE /providers/active`,
    `models` without key → 400.
  - **Real LLM round-trip**: set OpenCode Zen active via `POST /providers/active`,
    then `POST /llm/chat` → live API, `model: mimo-v2.5-free`, real token usage
    (`102`/`18`). `POST /agent/plan` → live call; the free model returned an empty
    completion → route correctly returned **422** (replan signal), never a
    fabricated action or a 5xx.

**Defect found and fixed** — a request body that fails TypeBox schema validation
(missing required field) returned **HTTP 500** `FST_ERR_FAILED_ERROR_SERIALIZATION`:
Fastify's default validation-error object (`{statusCode,error,message}`) has no
`detail`, so it failed to serialize against the route's `400` response schema
(`ErrorResponseSchema`, `detail` required). FastAPI returned **422** for the same
input. Fix in `src/app.ts`: `setErrorHandler` maps `error.validation` → `422
{"detail": …}`, other 4xx → passthrough with `{"detail": …}`, 5xx → `{"detail":
"Internal Server Error"}`; `setNotFoundHandler` → `404 {"detail": "Not Found"}`.
Re-verified through the browser: 422 / 404 / handler-path 400 all correct; Vitest
still 178/178.

### Verification

- `npm run build` in `frontend/` — clean (runs `backend:build` → `tsc -b` →
  electron `tsc` → vite build).
- `npx tsc -p electron/tsconfig.json` — clean (`backendProcess.ts`, `main.ts`,
  `webviewContextMenu.ts`).
- `npm run lint` — 28 pre-existing errors in files not touched this phase
  (`kimo-preview.tsx`, `providerApiClient.ts` `any`-casts, react-hooks rules);
  **zero new** errors from Phase 5 files.
- `backend-node` `npm test` — 178/178.
- `frontend` `npm run test:e2e` — 16/16 (real-CDP runtime + agent-mode UI +
  startup), run against `main.js` with the new `backendProcess` spawn wiring.
- Live smoke: `node dist/server.js` on `:8000` — `/health` (Node runtime shape),
  `/providers/presets` 200, `/security/check-prompt` 200, `/crawler/render-url`
  404 (removed).
- Phase 5.5 browser smoke (Chrome DevTools MCP → live `:8000`): 15/15 endpoints,
  real CORS, endpoint isolation, real OpenCode Zen `/llm/chat` round-trip; the
  `setErrorHandler` fix re-verified (422/404). `backend-node` `npm test` 178/178
  and `frontend` `npm run test:e2e` 16/16 both re-run after the fix.
