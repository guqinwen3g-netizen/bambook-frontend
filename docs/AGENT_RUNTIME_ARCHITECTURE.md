# Bambook Agent Runtime Architecture

## 1. Product Boundary

Bambook Agent is not a chatbot embedded in the UI. It is the native automation layer of Bambook.

The assistant window is only one interaction surface. The Agent must be able to read Bambook business objects, operate Bambook workflows, and report its work through the application workspace.

The model API is not the Agent. The Agent is the Bambook runtime around the model:

- identity
- session state
- memory
- retrieval
- tool planning
- tool execution
- approval
- audit
- workspace updates
- final user communication

## 2. Runtime Ownership

Business state belongs to the Bambook data center, not the client.

The client may hold UI state, preferences, temporary draft text, local cache, and media playback state. It must not be the source of truth for:

- account identity
- roles and permissions
- Agent sessions
- Agent messages
- business data
- orders
- product assets
- digital archives
- knowledge documents
- tool execution state
- audit logs

The Agent runtime must recover session history from `AgentSession` and `AgentMessage` on the backend. Frontend-provided `history` is only an optimization, not an authority.

## 2.1 Data Truth Boundary

For account, order, product, knowledge, and Agent audit questions, the production Bambook API is the business truth.

Local `localhost:8081` and local Postgres databases are development runtimes only. They may have empty users, empty product data, stale migrations, or synthetic tool runs. They are useful for validating source code and migrations, but they must not be used to answer questions about current Bambook business state.

Operational checks should use:

```bash
npm run agent:status
```

Local runtime checks must be explicit:

```bash
npm run agent:status:local
```

`/api/agent/status` exposes `dataSource.isBusinessTruth` so callers can distinguish production truth from local development state before interpreting `users`, `audit`, or tool-run counts.

## 2.2 OpenBitFun local integration — guarded resumption (2026-10-11)

The user authorized resumption after reboot. The incident photo reports **OpenBitFun 201.35 GB**; it does not distinguish the application from its descendants. No pre-crash process trace exists, so original-incident attribution remains unconfirmed. The integration is **not an accepted MVP**.

### Resource boundary

- `scripts/openbitfun-runtime.mjs`: `OPENBITFUN_SUSPENDED = false` after explicit authorization; `spawnGuarded` / `runGuarded` monitor owned process-family/group RSS every 500 ms. Runtime budget: 2 GiB. Generic `start-openbitfun.mjs --guard` budget: 3 GiB / 180 s. Preparation subprocess budget: 6 GiB / 15 min, one Cargo job, Node heap capped at 3072 MiB.
- Stop on owned-task budget, detected OpenBitFun application-family RSS above 8 GiB, macOS swap above 2 GiB or growth above 1 GiB, timeout, or monitoring failure. Only owned groups are signalled (SIGINT, then SIGKILL); never terminate the user's application. Completed children are not signalled again; cancelled startup cannot silently resume spawning/hosting.
- RSS polling is **not a hard OS allocation quota**. Detached children escaping between samples remain a limitation. Do not claim guaranteed prevention or that the user's application leak is resolved.
- `electron:dist` does not automatically prepare OpenBitFun. Successful guarded preparation restored the staged binary's execute permission. The 1.5 GiB Node heap attempt stopped safely; the 3 GiB heap build succeeded with approximately 3285 MiB process-family RSS. Source checkout is pinned at `0f1f1708a7eaf1974708578655d93525a38b74a6`.

### Browser development entry

- `npm run dev` → `scripts/dev-stack.sh` now starts the guarded CLI through `scripts/openbitfun-dev.sh`; no Electron packaging is needed. Entry remains **平台 → AI 助手（开发中）**. Browser origin `localhost:3000` reads readiness from `127.0.0.1:1422/bambook/status` and embeds the complete Web UI.
- Dev startup does not run a heavyweight prepare or clear ports 8080/1422. An unprepared checkout needs an explicit `npm run openbitfun:prepare`; startup failures/conflicts go to `logs/dev-openbitfun.log`. Ctrl+C/exit stops only the runtime job owned by that dev shell, preserving existing business-service nohup behavior. Completed/reused PIDs are not signalled.
- Focused checks: Bash syntax; 3 dev-startup tests plus 11 existing guardian/lifecycle tests; an isolated real-runtime startup/readiness/CORS/Web-UI/shutdown check. The whole `dev-stack.sh` was not executed during verification because its existing cleanup kills processes on business/frontend ports; only the new startup path was exercised without touching those services.

### Findings and current checkpoint

- Real-browser fixture runs reproduced growth in **openbitfun-server itself**, not a model provider: the 2 GiB guard stopped it around 2051–2095 MiB, before any local model request. Browser runners closed; sampled swap remained zero. Logs and bounded sampling evidence: `tmp/upstream/openbitfun-guarded-*-smoke.log`, `openbitfun-server-growth.sample`.
- ACP 0.12.1 `jsonrpc/handlers.rs::ChainedHandler::describe_chain` recursively Debug-formats already formatted strings; deep chains can grow exponentially. `incoming_actor.rs` invokes this on handler-error warnings. The server now filters only that module below ERROR; RPC error responses and other host warnings remain enabled. This is a targeted mitigation, not an upstream-library repair or proof about the original 201 GB incident.
- With the filter, the same isolated browser path stayed around 170 MiB server RSS instead of hitting 2 GiB. Its next failure was explicit `Method not found`, with zero model requests. Temporary fixture configuration was restored successfully in that run.
- WebSocket EOF/error/close/drop now signals the existing `AppServerDisconnect` owner; ping/pong no longer incorrectly ends the application stream.
- Completed checks: 14 Bambook tests (11 guardian/lifecycle + 3 integration component, rerun passed in `bambook-openbitfun-checks.log`, peak 343 MiB); 2 Rust transport tests; 1 Rust logging-filter test; 50 upstream frontend adapter/SystemAPI tests. Rust tests were narrowly scoped server-binary tests; the earlier broad library-test attempt still fails on the unrelated missing `SETTINGS_SYNC_CAPABILITY` and must not be reported as passing.
- `scripts/openbitfun-host.patch` now includes the browser URL-opening/config-envelope adapters, typed subscription delegation, workspace/session readers, disconnect handling and logging filter. Core MIT / third-party notices are staged with the bundle.
- Added real-owner delegation for `get_available_modes` and `manage_dialog_queue`; queue operations use `AgentRuntime::manage_dialog_queue` (epoch fencing/idempotency/attachments), never fabricated success. External plugin routes are not advertised before their activation lifecycle is supported.
- Further browser traces exposed wire mismatches: profile lookup needs `agent_id`, generic `agent/createSession` ignores the desktop draft's reserved ID, and typed `agent/event` was not consumed by the legacy browser listener. The narrow create/model adapters now preserve exact identity and atomic selection; `bambook-host` event forwarding uses the existing shared `project_agentic_frontend_event` while retaining typed/cursor delivery. Config/permission events also unwrap their typed envelopes.
- Latest full guarded prepare exited 0: `openbitfun-guarded-prepare-restore.log`, Cargo peak 2294 MiB. `openbitfun-guarded-history-smoke.log` exited 0: two real streaming HTTP requests, reply body rendered, invalid/unregistered workspace and remote-scope requests rejected, refreshed history reopened by session identity and rendered. The upstream Web shell opens its home screen on reload, not the last tab; the smoke now explicitly selects the persisted sidebar row instead of assuming automatic tab restoration. Temporary fixture model/defaults were restored. Runtime stopped at peak 188 MiB; browser runner peak 930 MiB.
- Added local-only `get_session_permission_mode` delegation to the actual session manager. New `restore_session_view` / `load_persisted_session_metadata` adapters resolve registered workspace identity (never a supplied filesystem path), reject remote scope, and delegate to the shared persistence/runtime owners. Restoration returns the existing interaction/event projections and bounded tail (up to 16 turns, explicit partial status). Both browser refresh and backend restart restoration now pass. `openbitfun-restarted-history-check.log` records durable turns recovered after restarting the server and real UI body rendering; restarted server peak 143 MiB, browser runner peak 625 MiB. All owned test processes have been stopped. Screenshots `openbitfun-local-fixture-chat.png`, `openbitfun-local-fixture-restored.png`, `openbitfun-restarted-history.png` are actual isolated upstream captures, not full Bambook-shell visual acceptance.
- `scripts/openbitfun-smoke.mjs` requires explicit isolated E2E storage, a fresh unconfigured namespace, and a local HTTP model fixture; no employee credentials are read/imported. Earlier killed runs retain fixture data only under `tmp/openbitfun-e2e-*`. The normal integration fixture was removed and its primary selection returned to unconfigured.

### Subscription authorization copy fallback

- User requested a fix in the **Bambook-embedded** OBF. `ModelSettingsPage.tsx::handleCopySubscriptionAuthorization` now copies the current pending URL through `SystemAPI.setClipboard`; browser and device-code flows retain opening/copy-code actions. A read-only, focus-selectable link field remains usable if clipboard access fails. Layout reuses upstream `Input size="sm"`, inline `Button variant="text"`, and the existing wrapping action row; no new CSS or branding migration.
- Opening/copy failures have actionable localized feedback (en-US / zh-CN / zh-TW). Authorization URLs and raw opener errors were removed from these UI diagnostics; no new persistence or Bambook token bridge. Tests use only dummy authorization data, never employee credentials or current login sessions.
- `openbitfun-authorization-tests.log`: 62 focused tests passed, including both authorization methods, opener failure, clipboard denial/manual selection, and absent-URL behavior; runner peak 554 MiB. The guarded Web-only build/staging succeeded (`openbitfun-authorization-build.log`, peak 3256 MiB); the user's running backend PID was left untouched. Changes are included in the deployable host patch. Refresh/restart the **frontend** to load new assets; a newly initiated login will show the new controls.
- The current user's login screen was not inspected or captured. `openbitfun-authorization-browser-check.log` exited 0 (peak 864 MiB): an offline browser fixture intercepts **all** RPCs/HTTP away from the test asset host, uses dummy authorization data and a mock clipboard, and verifies blocked opening, exact URL copy, both clipboard paths denied, and manual selection. Actual fixture panel captures: `openbitfun-authorization-copy.png` (1440×900 viewport) and `openbitfun-authorization-copy-narrow.png` (800×900 viewport), under `tmp/upstream/`; these are not real-provider or full-shell visual acceptance. Full-shell visual / dual-theme and real-provider authorization acceptance remain pending.

### Source HMR and subscription-model discovery checkpoint

- `npm run dev` now invokes `start-openbitfun.mjs --dev`. The runtime launches upstream `src/web-ui` through the real Vite config in **web** mode (HTTP 1422 / HMR 1421), with source design-system aliases; packaged production retains the static bundle (unpackaged Electron now uses source mode as recorded below). Frontend edits can hot-update; Rust remains a compiled sidecar and needs an explicit guarded rebuild/restart. No implicit prepare or Rust watcher was added.
- `scripts/openbitfun-web-dev.mjs` preserves loopback, Host/Origin validation, parent CORS and frame boundaries plus `/bambook/status`. Vite is separately guarded at 3 GiB family RSS / 1536 MiB Node heap; either owned process exiting stops its sibling. Normal frontend shutdown signals the parent first with bounded 750 ms CLI exit and group cleanup; resource-pressure failures still immediately signal the whole group and retain the 1 s forced deadline. This avoids signalling esbuild mid-close without weakening limit handling.
- `openbitfun-dev-hmr-tests.log`: **17 tests passed**, peak 259 MiB, including owned-family shutdown, normal frontend worker grace, and immediate group signalling on resource limits. `openbitfun-hmr-check.log`: isolated real-browser source modification hot-updates without navigation and preserves interaction state, peak 204 MiB. `openbitfun-real-dev-check.log`: actual upstream config/CLI serves Vite client and transformed web-mode main entry on unused ports and shuts down under the guard, peak 480 MiB. Earlier first-start optimizer shutdown checks failed; bounded parent shutdown is the verified correction. Whole dev-stack and authenticated full-shell/React Fast Refresh acceptance remain untested.
- Root cause found for the reported model-list failure: `AIApi.listModelsByConfig` sends `list_ai_models_by_config`, which passed through the WebSocket adapter but was absent from the Bambook host surface. `bambook_host.rs::discover_models` now uses the same transient AI client contract as Desktop, the shared subscription-auth/request-profile owner, global proxy settings and actual remote model discovery. Only model descriptors return; no discovery draft persistence, employee credential inspection, hard-coded account catalog or business-data bridge. The operation has a 30 s deadline and redacted error reasons.
- `openbitfun-model-discovery-build.log`: guarded offline server build passed, peak 2212 MiB. `openbitfun-model-discovery-test.log`: **1 production app-server integration test passed** with separate E2E HOME/user/config roots and a local HTTP fixture, covering invalid requests, real model-list delegation and provider-error redaction; peak 1769 MiB. New host unit tests were added but the previously known broad library-test blocker was not retried. Real ChatGPT subscription catalog/entitlement and a model turn remain user-side acceptance, not proven by the fixture.
- Host patch regenerated and reverse-apply checked. Rebuilt native binary staged by atomic inode replacement; the user's authenticated PID 78622 was not signalled or restarted. These backend changes and HMR startup take effect on the next user-owned development/runtime restart, not by refreshing the currently running static frontend. No UI layout changed in this step; full-shell visual acceptance remains pending.

### Bambook-native conversion — user requirements and next implementation slice

- User treats the embedded product as the completed first step and now explicitly requests a **Bambook-native Agent and Harness**, adapting functionality, interaction, visual identity and UI rather than retaining the upstream programming-workspace product. This is a new implementation phase; the items below are decisions/planned work, **not completed UI or runtime changes**.
- User-authorized runtime restart completed before this phase: old manager 78478/native 78622 stopped; source-mode manager 34360/native 34394/Vite 34408 now serve readiness and HMR. Live `list_ai_models_by_config` with an entirely missing config returns -32602 rather than the old -32601. `{config:{}}` is not the same contract probe: model config defaults can deserialize it and yield an internal discovery error. Real subscription model/catalog acceptance remains separate.
- Navigation direction: inner sidebar contains a direct new-conversation action, flat conversation history and necessary model/account settings. Remove project/workspace creation, switching and grouping plus remote-project, custom-Agent, external-CLI and programming-product launchers from employee navigation. Do not replace them with fabricated business shortcuts, counts or approval actions; Bambook's outer business navigation remains authoritative. Business-context actions appear only when backed by real context and services.
- Single workspace means one invisible, registered local runtime owner per employee context, **not deletion/merging of existing workspaces/history or one shared company session store**. Workspace ID remains authoritative for create/load/restore and persistence; filesystem paths are IO projections, not business permission scopes. New conversation creation must pin the default owner; restoring old sessions must preserve original ownership and report incompatible scope rather than silently rebinding.
- Initial Harness recommendation: use **Standard** as the balanced execution baseline, not the most minimal or complex variant. Source contract lists Minimal/Standard/Ultimate/Creative (`src/shared/agent-harness/contract.json`). Cowork is a separate office/collaboration Agent (`agents/definitions/modes/cowork.rs`), not a fifth Harness; its prompt is a useful behavioral reference, but neither it nor Standard's existing coding prompt/tool set should be enabled unchanged as the business agent. Employee UI exposes one Bambook identity, not the upstream selectable modes/custom Agent/CLI catalog.
- Native conversion must define a reviewed business instruction profile and explicit available tools, supported host adapters, model/timeout/context limits and HITL policy. Cowork currently includes ExecCommand/Delete/AgentSpawn/ComputerUse/Cron; hiding their navigation is not capability removal. Do not infer safe business behavior from an office label, prompt-only guard or concealed selector. Preserve personal model/subscription connections; no company AI pool is introduced.
- Source implementation anchors: `NavPanel/NavPanel.tsx` composes MainNav, scene navigation and PersistentFooterActions; `MainNav.tsx` hosts upstream launchers/workspace groups. `WorkspaceItem.tsx::handleCreateSession` uses `flowChatSessionConfigForWorkspace` + `createChatDraft` + `openMainSession`. `SessionsSection.tsx` already supports scoped flat rows and owner-backed history. `HarnessProfileSelector.tsx` and ChatInput contain additional profile/Agent entry points; replacing only the sidebar will not remove them. Native owner-side policy must eventually match all entry points.
- Composition direction: keep the existing Bambook shell/sidebar unchanged; inner assistant gives the main visual area to conversation, with a quiet narrow history rail and necessary settings at its bottom. No nested business-domain directory, workspace cards or redundant explanations. Native BDS colors/type/actions and focus/empty/loading/failure/narrow states require actual baseline and after screenshots before acceptance. Frontend discipline and relevant R5/shell/action references were read; no product UI changes or visual pass are claimed yet.
- First code slice: minimal sidebar + scoped default-workspace new conversations/history + necessary settings; then pin one reviewed Harness/profile across create/submit and remove all alternative execution selectors. Follow with business tool/auth/context adapters through Bambook's existing server-owned permissions, drafts, approvals and audit. This phase does not authorize a direct local-to-business data-write bypass.

### Native presentation replacement checkpoint (2026-10-11)

- Latest direction: the user rejected a theme-only adaptation. This phase replaces upstream presentation owners with shared BDS components, rather than claiming token mapping completes the native product. Keep the approved outer sidebar and its 24px content corners unchanged.
- R5 composition: transcript remains the main task; the editor is an open multiline field with a focus baseline, followed by leading attachment actions and trailing model/send controls. Stable two-row composition avoids switching between an inline capsule and a boxed editor. Bambook holds the multiline presentation from first mount and bypasses the old off-screen capsule cloning/width-mutation measurement; other presentations retain their original measurement logic. Long input scrolls within a bounded three-control-height field. No fake business actions or extra explanatory copy are added.
- Shared owner: `components/agent/BambookComposer.tsx` and `styles/bds/agent-composer.css`. It replaces ChatInput's original composer DOM through `@bambook/agent-composer`, with the same source alias for serve/build and an explicit FS allowance. Actual RichTextInput, composition events, attachment handling, queue, model menu, transport and approval band remain owned by upstream. Busy/disabled presentation does not disable the stop action or remount the editor.
- Empty conversation: `WelcomePanel` mounts the existing static Bambook WelcomeScene instead of the legacy Git/project/Cowork welcome subtree. The native branch does not subscribe to welcome-panel Git polling; legacy branch tests remain intact. This is presentation removal, not backend tool restriction.
- Targeted tests: shared composer 3/3 (refs, slot ordering, state transitions preserving editor and IME callbacks); welcome/Vite integration 14/14 (native boundary avoids Git subscription, legacy contracts, shared source resolution). Guarded peaks 338/469 MiB. No full build or real model/account request.
- Final targeted rendering: fresh-profile offline Chromium and Electron both passed with actual attachment selection, native composer geometry, long-draft internal scrolling, retained editor identity, no capsule mode, and 1440×900/800×900 light/dark workbenches. Final family peaks were1798/2129 MiB. CSS viewports are1440×900/800×900; Electron's initial light1440 capture is2880×1800, while captures after explicit viewport resizing are1× raster. Evidence directory: `docs/design-system/evidence/bambook-agent-composer-2026-10-11/`. Existing unavailable-RPC warnings and a blocked browser fixture HMR WebSocket remain; this is not clean authenticated E2E or proof of HMR delivery. No subjective visual approval or populated streaming/approval-turn acceptance is claimed.
- Verification resource incidents: an initial browser proxy request reset; rerun passed. An Electron attempt exhausted its deliberately limited384 MiB Node heap and aborted at sampled family1715 MiB; rerun with512 MiB heap passed under the unchanged3072 MiB family guard and180s timeout. The abort left an orphan Playwright Electron (PID66229); its exact offline temporary main.cjs/loader arguments were verified before sending SIGTERM. Production backend and desktop processes were not signalled. This is not a diagnosis of the earlier machine memory incident or a hard OS memory guarantee.
- Live source1422 serves the new composer import with HTTP200; existing backend PID70100 was not restarted. Root3000 remains source-supervised. Full user-window appearance and input are not verified by a GET.
- Still incomplete: native session header/history composition, populated transcript/tool/approval presentation, native account/model editor, residual coding commands, curated business tools/system instructions and server-enforced authorization/audit. Do not call this checkpoint the final Bambook Agent.

### Sending and authenticated MCP transport checkpoint (2026-10-11)

- User priority: connected personal subscription models must actually send conversations, then the embedded Harness must reach Bambook business services. Do not equate a working chat or exposed MCP endpoint with completed ecosystem integration.
- Reproduced frontend obstruction on live source1422: editable input, ready model and enabled Send, but the upstream FloatingMiniChat intercepts the normal pointer click. `AppLayout.tsx` now gates that subtree with `!BAMBOOK_PRODUCT`; the layout contract and offline brand script assert its absence. No send/model/queue gating was bypassed.
- Actual sending verified in fresh-profile Chromium and an independent Electron test window, both against live source1422/backend8080. Normal clicks submitted exactly once through `manage_dialog_queue` action `submit` and rendered the real harmless response `BAMBOOK_UI_SEND_OK`. Diagnostic sessions were retained. Existing employee history RPCs were replaced with empty results; no employee conversations or credentials were inspected. This is not full-shell/user-window acceptance.
- Evidence: `docs/design-system/evidence/bambook-agent-send-2026-10-11/{browser,electron}-real-model-send-light-1440.png`. Tree removal is theme-independent; no palette/material change or subjective visual approval is claimed. Visual acceptance remains pending. Guarded process-family peaks were993/997 MiB. Electron's first attempt failed on unsupported context.newPage; the diagnostic now uses firstWindow and passed after cleanup.
- Other unsupported legacy RPCs remain, including save_session_turn/save_session_metadata, computer-use and dispatch. A rendered model reply does not establish persistence, stop/retry, restored histories, tools or HITL acceptance. Native runtime independently persists its own turns; do not claim that resolves every frontend compatibility path without tests.
- New server source endpoint: `POST /api/agent/mcp`, implemented by `mcp/httpTransport.ts`, supports initialize/ping/tools/list/tools/call, bounded tool pagination and request/result budgets. GET/DELETE return405. MCP browser Origin validation supplements authentication; native clients may omit Origin. Business notifications never execute tools.
- The standard endpoint always requires a verified JWT or employee-bound API key, even when legacy development reads are enabled; it never invokes the legacy body-selected development actor. Tool manifest/schema ownership stays in getMcpManifest; execution stays in runMcpPlan/toolRuntime, with current grants, credential ceilings, row scopes, approvals and audit. No raw database query or independent write bypass was added. ApprovalPending remains pending; failures are not exposed with raw internal diagnostics.
- Targeted upstream layout, MessageModule and websocket adapter checks:84 passed, peak389 MiB. MCP protocol and actual-auth/scoped-orders fixture suites:33 passed on the final rerun, peak470 MiB. Existing storage fixture now supplies account.findUnique and department.findMany required by the current L2 resolver, without mocking authorization decisions. Selective ES2018 transport/test typecheck passed, peak157 MiB; no whole-project build/typecheck was run.
- Upstream host patch regenerated preserving its eight existing new-file entries and reverse-apply checked. Existing live production services were not restarted/signalled; no account settings were changed. Resource-heavy checks were serial under the3072 MiB/180s sampled family guard, not a hard OS quota.
- STILL INCOMPLETE: automatic employee-scoped auth/context bridge from embedded Harness to this endpoint, runtime MCP registration/lifecycle/logout isolation, curated business Harness/tool capability boundary, deployment/activation of the new Bambook endpoint, real authorized business query/write/approval E2E and comprehensive business-tool coverage. Do not advertise all data/all functions as connected. Next work must pin employee/session identity, avoid credentials in prompts, preserve native approval flows and validate against actual business services.

### Multi-turn readiness regression checkpoint (2026-10-11)

- User reproduced a second-message failure; the earlier single-message check was insufficient. Fresh-profile live-source browser reproduced first success, then ensure_coordinator_session -32601 and failed create-session fallback. No employee history/credentials were inspected; diagnostic prompts prohibit tools/files/business operations.
- Fix: `server/bambook_host.rs` advertises and implements ensure_coordinator_session, dispatched through fallback.rs to the existing runtime-backed session_read owner. Registered workspace ID, local/remote rejection and deployment ownership checks remain. resolve_persisted_session_storage_path supplies the canonical storage root before ensure_session_loaded_from_storage_path; using the workspace directory directly caused a first intermediate -32603 and was corrected. Loaded sessions are reused; unloaded sessions restore through Core. No fake readiness, per-message recreation, context clearing or weakening of session storage-path binding.
- includeInternal remains explicitly optional/default-false, with camelCase/snake_case compatibility and Rust deserialization assertions. Non-local references never fall back to a local scope. Frontend readiness/submission gates remain unchanged.
- Final focused server build: cargo build --locked --offline --manifest-path src/apps/server/Cargo.toml, one job/no debug info, passed in14.34s, sampled family2126 MiB. Bundle executable replaced atomically, then only the exact verified owned native child was gracefully interrupted; its existing Electron manager stopped its own Vite. The trusted main-renderer start bridge restarted the runtime and returned ready. Main app PID77982 and employee settings/storage were preserved; no DOM or conversations were read by the restart helper.
- Fresh-profile live Chromium and independent Electron window both passed three normal-click submissions in the SAME session (exactly3 RPC submits, one session ID, zero visible alerts). Third prompt did not contain the first reply's random marker and correctly recalled the full first response, proving live context continuity rather than creating separate conversations. Peaks981/1028 MiB. This is not full-shell user-window or cold-restored-history acceptance.
- Screenshots: `docs/design-system/evidence/bambook-agent-send-2026-10-11/{browser,electron}-real-model-multiturn-light-1440.png`,1440×900 requested viewport, light. Backend behavior only; no UI styling changed or new visual approval claimed. Diagnostic helper now checks all three turns and same session identity; existing single-turn screenshots retained.
- Permanent source-boundary checks: scripts/openbitfun-session-readiness.test.ts,3 passed, peak189 MiB. These prove registration/delegation/path-owner structure only, not runtime behavior; the live model checks above provide separate behavioral evidence. Host patch regenerated, preserving8 new-file entries, reverse-apply checked.
- Rust library unit-test attempt did NOT pass: existing handlers/app.rs test compilation references missing management::SETTINGS_SYNC_CAPABILITY, then the3072 MiB family guard interrupted rustc at sampled3290 MiB. No retry with a higher memory budget, no unrelated source fix, no passing-unit-test claim. Production server builds and actual multi-turn checks passed separately. Checks remained serial; sampled memory guards are not hard OS quotas.
- Residual legacy save_session_turn/save_session_metadata/computer-use/dispatch RPC errors remain. Persistence/history restore, stop/retry/queue edge cases, tools/HITL and automatic employee business-MCP bridge still need their own acceptance; do not extrapolate three-turn success to all Agent features.

### Native frontend reduction checkpoint (2026-10-11)

This checkpoint supersedes the “not implemented yet” status above for the frontend slice only; business capability restriction is still pending.

- Composition: the existing outer Bambook shell is unchanged. A quiet conversation rail owns new conversation, flat history, models/accounts and legal About; the conversation canvas remains the focus. `NavPanel/BambookNav.tsx` replaces mounting MainNav/scene navigation/PersistentFooterActions, rather than concealing their launchers with CSS. BDS rail geometry and resting welcome typography live in `styles/bds/agent-theme.css`; shared ScrollArea supplies edge alpha fades.
- Entry: `OpenBitFunWorkspace.tsx` uses one plain connection/error status. The Bambook preload sets the initial local light/dark canvas and removes the in-frame startup overlay; index HTML suppresses its first paint, App has no minimum showcase delay, and WelcomeScene no longer runs a slogan/typewriter carousel. The source build initializes BDS before the parent handshake; subsequent parent theme messages still require the original origin/source/version checks and never change account settings.
- Sessions: `bambookProduct.ts` resolves the existing host local workspace suffix (`openbitfun-workspace` / installed `agent-workspace`), falls back only to the sole eligible local owner and fails closed on ambiguity. New drafts and toolbar creation explicitly use Standard and authoritative workspace ID/path; existing history and its execution modes are not rewritten. Flat history retains original local owners and compact rename/export/archive/delete menus, with no workspace badge or IDE/storage/scheduler/worktree actions.
- Resource boundary: Bambook history performs one 30-item metadata page request per explicit load, including sequential legacy-owner traversal. It does not run upstream’s automatic all-pages/all-scopes/archived traversal. Repeated or missing continuation cursors fail instead of looping. This reduces one known unbounded read path; it is not a diagnosis or guarantee against the earlier ~200 GB incident.
- Composer/chrome: no Harness/Agent/boost catalog, workspace/git/dispatch strip, scene tabs/actions, terminal bridge or global product search is mounted. Image picking, file/context reference, model selection, send/stop and existing approval machinery remain. Settings only accept the model/account destination through the existing draft navigation guard. Project launcher/native project menu/ACP creation events are suppressed at the modified shell handlers; this is not a server authorization boundary or proof every shortcut/slash command has been removed.
- Final checks: 54 focused upstream tests (policy, bounded paging, navigation, model settings guard, history geometry, startup, draft registry) and 36 host/appearance/brand/dev-watch tests passed under serial guards (455 / 374 MiB peaks). Fresh-profile Chromium and Electron production wrapper/source checks both passed: new conversation, image file chooser/attachment, persistent simplified rail, no boost/workspace strip, About, model/account settings, theme without iframe remount and narrow settings. Family peaks: 1877 / 1943 MiB. Evidence: `docs/design-system/evidence/bambook-agent-native-2026-10-11/`, browser1440×900/800×900 and Electron1440×900 CSS viewport at2× raster, light/dark. The fixture deliberately leaves unrelated backend/Tauri RPCs unavailable and emits associated warnings/errors; this is not a clean real-account E2E or full-shell/native mouse acceptance. No employee profile, conversations, tokens or real model requests were inspected. Host patch regenerated and reverse-apply checked; no full build.
- Live source correction: port3000 was actually `vite preview --port 3000 --strictPort` (verified PID260 and repository cwd), while1422 already used source/HMR. Replaced only that preview with a supervised Vite source server: supervisor28887 / Vite28925, Node512 MiB heap, sampled family3072 MiB cap, no timeout. Log/entry: `tmp/upstream/bambook-native-web-live.log` and `bambook-native-web-supervisor.mjs`. Root and Agent source GETs return200 and3000 now contains the Vite client marker. Manager53488/native53502/source host53517 were preserved. `vite.config.ts` excludes tmp/upstream/runtime, generated artifacts/evidence and design copies from the host watcher; components/styles stay watched, the separate1422 watcher owns Agent HMR. These are sampled limits, not an OS hard quota or a guarantee against all memory failures.
- Remaining: curated business prompt/tools, server-enforced capabilities/HITL/audit, thorough residual shortcut/slash-command cleanup, real account/model turn and full-shell/native user visual acceptance. Do not describe this frontend reduction as a completed business-safe Agent.

### Browser/desktop development runtime alignment checkpoint

- Reported desktop-only 8080 conflict came from a second startup owner: Electron recognized only its own child, used a different workspace and did not reuse the CLI-hosted service. `electron/main.ts::getOpenBitFunRuntime` now uses the same project `tmp/openbitfun-workspace` in unpackaged development, source `src/web-ui` and an explicit absolute `openbitfun-web-dev.mjs` entry. Packaged installations retain their persistent userData workspace and static assets; existing data is neither deleted nor migrated.
- `scripts/openbitfun-runtime.mjs::readSharedWorkbench` validates the pinned revision/URL/state, backend health, the known 8080/1422 listener owners, exact backend binary/workspace arguments and shared manager ancestry. Development also requires the Vite client marker. Missing diagnostics or mismatched identity fail closed. Observing a peer stores no owned process and never signals it; development windows can reuse a matching service rather than launch a duplicate. Simultaneous first launches before either service is observable are not proven race-free.
- `openbitfun-shared-tests.log`: **27 focused tests passed** across shared/runtime/dev suites, guard peak 305 MiB; runtime syntax check passed. Read-only live checks confirmed the existing HMR service's actual listener/workspace identity, observer start/status reuse and readiness after observer stop, without restarting the authenticated runtime. The private OS inspection helper was exercised by this live check; injected fixtures cover rejection and cancellation paths.
- `openbitfun-electron-main-check.log`: actual Electron main configuration built successfully in isolation (2 modules, 206 ms), with `emptyOutDir=false`, leaving preload/renderer untouched. `out/main/main.js` now contains the fix for `electron:start`; already-running Electron must reopen to load its new main code. No full desktop launch, authenticated UI capture or visual acceptance was performed. Resource guards remain unchanged; no global port cleanup or service restart occurred.

### Embedded frontend foundation checkpoint

- Scope requested: fill Bambook's main area and align the embedded Agent's typography and palette before sidebar/Harness reduction. `OpenBitFunWorkspace.tsx` now uses `styles/bds/agent-workbench.css`: the ready iframe fills the canvas with no duplicate outer PageHeader/panel padding; connecting/failure states retain the shared header, explicit status and retry. The outer Bambook navigation/curved shell, sandbox and account/workspace ownership are unchanged.
- `styles/bds/agent-theme.css` imports BDS tokens and local Light font faces, projecting existing OBF semantic/component variables to BDS; `primary-actions.css` adds an embedded-only selector to its existing primary recipe. No second palette or account/config migration. `src/web-ui/src/bambookAppearance.ts` accepts only versioned light/dark messages from the exact allowed parent; the parent validates iframe origin/source. Only a constant readiness message leaves the iframe. BDS activates its dark tokens through the explicit `data-bambook-theme` selector rather than reviving OBF's retired Theme DOM contract. A root-attribute-only observer keeps the visual mode consistent if upstream Appearance initialization finishes later; no subtree/content observer is added. Theme changes preserve the iframe and do not write subscription, session or appearance settings.
- Upstream `main.tsx` installs the adapter; `vite.config.ts` resolves the shared BDS CSS and limits extra source access to BDS/font directories. `prepare-openbitfun.mjs` supplies the project root and includes font notices when preparing a distributable. Host patch regenerated and reverse-apply checked. No native rebuild or runtime restart was performed.
- Actual-source HMR defect found: merged upstream `watch.ignored = **/apps/**` matches this repository's entire absolute path under `Claw/apps/Bambook`. `openbitfun-web-dev.mjs` now replaces that list after config resolution instead of concatenating it; keeps target/.git/dist exclusions and native filesystem events. Regression fixture lives under an `apps/` ancestor and imports the upstream ignore rule; HMR updates without navigation and retains interaction state. At this checkpoint, live Vite 34408 still had the old watcher/config; the fix and new theme entry required a service restart, not only a page refresh. The subsequent authorized live-update checkpoint below records activation.
- `openbitfun-appearance-tests.log`: **26 focused tests passed**, final peak 300 MiB. `openbitfun-appearance-hmr.log`: guarded real-browser HMR/origin/host checks passed, peak 280 MiB. `openbitfun-appearance-browser.log`: actual wrapper plus full OBF source UI passed fill bounds, theme-token/root-font-size/300-weight checks, native visual mode synchronization, theme switch without iframe replacement and settings opening; final peak 1635 MiB. All provider/native RPCs were intercepted with offline fixtures, no employee profile or credentials accessed. Earlier browser harness attempts failed on fixture CORS/JSX-runtime routing and shutdown handling; final run exited 0 after those fixture corrections.
- `openbitfun-appearance-audit.log`: complete `check:web:appearance` passed, including all 24 color surfaces and 10 visual-contract surfaces; peak 589 MiB. An initial audit rejected the legacy Theme attribute; the implementation now uses the explicit BDS host attribute, without relaxing audits. `openbitfun-appearance-target-types.log`: strict isolated type-check of the new host adapter passed, peak 191 MiB. Full `check:web` remains blocked by missing rustfmt in the installed Rust toolchain; separately running `type-check:web` reached tsc (peak 2013 MiB) but fails on the earlier ModelSettingsPage `copy` icon type and missing `@/generated/api` declarations. No blanket type/build success is claimed, no toolchain install or API generation was attempted, and the full static production frontend was not rebuilt.
- Actual rendered evidence (isolated wrapper/Agent, not full Bambook shell): `docs/design-system/evidence/agent-appearance-2026-10-11/` contains workbench light/dark 1440×900, settings light/dark 1440×900 and settings dark 800×900. These are candidate evidence, not user aesthetic approval; full-shell, native desktop, real account/model turn, every specialized control and all narrow interaction states remain unverified. No before screenshot of the authenticated UI was taken.

### Electron input regression checkpoint (2026-10-11)

- User reported the full-area iframe could no longer be clicked and still looked unchanged. Keep the R5 full-canvas composition and existing outer navigation; this correction changes no visual geometry, business permissions or account ownership. The root `index.css` marks `body` as a native window drag region. Neither the workbench nor its cross-origin iframe opted out; inner-document buttons cannot cancel the parent document's region. `agent-workbench.css` now sets `-webkit-app-region: no-drag` on both, leaving global window dragging and sandbox unchanged.
- Added `--electron` to `scripts/openbitfun-appearance.browser.mjs`: a fresh offline profile, actual root CSS and wrapper/full OBF source, with the production titlebar/security options (no preload/backend launcher). The baseline had `body=drag`, workspace/frame=`none`; its regression assertion failed as intended (`openbitfun-electron-drag-before.log`, peak 1861 MiB). After correction, both are `no-drag`; canvas, BDS tokens, theme preservation and settings clicks passed (`openbitfun-electron-drag-after.log`, peak 2204 MiB). These are computed native-region and CDP interaction checks, not OS-native mouse or complete live-shell acceptance. RPCs remained offline; fixture omissions still log unsupported native calls.
- `openbitfun-electron-drag-tests.log`: 14 tests passed (workspace + appearance), peak 343 MiB. Evidence in the existing `agent-appearance-2026-10-11/` directory: `electron-before.png`, `electron-workbench-{light,dark}-1440.png`, `electron-settings-{light,dark}-1440.png`, `electron-settings-dark-800.png`. No authenticated UI was captured; screenshots are isolated candidates, not user visual approval.
- Before the authorized restart: read-only checks found desktop host 3000 serving the new no-drag CSS (200), while Agent 1422 served an entry without `bambookAppearance` and rejected the shared stylesheet (403). This was separate from the input defect; that diagnostic phase did not stop the authenticated runtime. Activation is recorded below; actual user-window interaction and full-shell visual acceptance remain pending.

### Authorized live update checkpoint (2026-10-11)

- User explicitly requested immediate activation. Verified old manager 34360's command/cwd and exact shared listener ancestry; sent SIGTERM only to that manager and confirmed 8080/1421/1422 released. Started the same guarded `scripts/start-openbitfun.mjs --dev` with the same workspace; no account/config/session files were read, removed or migrated, and Bambook Electron itself was not restarted.
- New manager 53488, native 53502, Vite 53517. `readSharedWorkbench(requireDev=true)` passed owner/readiness checks; live entry, appearance adapter, shared BDS theme, desktop no-drag CSS and Vite client all returned 200 with expected source markers. The former stylesheet 403 is resolved. Startup log: `tmp/upstream/openbitfun-live-update.log`.
- Confirmed the actual live watcher emitted `hmr update .../styles/bds/agent-theme.css` after updating only that file's mtime; its bytes were verified unchanged. This establishes the live HMR emission path, not the user's visual approval or every client's applied state.
- Post-start sample: manager 114 MiB, native 144 MiB, frontend 353 MiB, system swap 0. Native 2 GiB and frontend 3 GiB family guards remain active (sampled RSS, not hard OS quotas). No full rebuild or additional full desktop was launched. Actual full-shell visual and OS-native mouse acceptance remain pending; account availability was not inspected.

### Global desktop/browser input boundary checkpoint (2026-10-11)

- User broadened the complaint to global click/drag failures, not only OBF. Preserve existing shell geometry, typography, material and business handlers. `index.css` now defaults body to `no-drag`; only explicit window chrome opts into drag (14px `WindowControls` strip and legacy Assistant fullscreen title headers). Browser CSS ignores this property. Do not return to whole-page drag plus an incomplete tag whitelist; tables/custom pointer targets must work by default. Dashboard colors/layout are unchanged, with its existing canvas opt-out retained.
- Independent overlay defect: the invisible 140×44 top-left control hot zone covered the collapsed sidebar toggle (actual BDS box left12/top20/40×40; hit test at32,40 failed). `WindowControls` now keeps that container pointer-transparent, delegates hover detection to document mouse coordinates, wakes only over explicit drag chrome/window controls rather than a business-tag whitelist, and removes listeners on unmount. Business div/span targets are protected too. Existing chrome geometry, leave delay and native/fullscreen ownership remain; Windows/Linux wrappers are transparent even while revealed, only actual buttons accept input, and hidden buttons leave the Tab order.
- `desktop-input-before.log` failed the expected body-region assertion (891 MiB); `desktop-input-hotspot-before.log` failed the expected collapsed-toggle hit test (865 MiB). Early fixture setup failures involved virtual JSX/CommonJS and continued optimizer requests; corrections stayed in the offline harness, not production security settings.
- `desktop-input-after.log` passed sequential Chromium/Electron checks: actual global CSS and WindowControls/side-toggle geometry, row click, input, pointer-capture resize, HTML drag/drop, two-axis wheel, portal and cross-origin iframe. Also checks native-control reveal IPC intent over chrome but not the business button. Final peak 1074 MiB. These are diagnostic fixtures/CDP events, not full business pages, OS-native mouse or Windows/Linux hardware acceptance; Vite's deliberately blocked fixture websocket emits an expected warning.
- `desktop-input-tests.log`: 24 tests passed across window static/interaction, embedded workspace and appearance suites, final peak 355 MiB; includes a mocked Windows/Linux revealed-button/transparent-wrapper path and listener removal. Existing Agent regression now expects default body no-drag. Evidence: `docs/design-system/evidence/desktop-input-2026-10-11/` contains body/hot-zone baselines plus browser/Electron light/dark1440×900 candidates. No account/business data or authenticated UI was inspected. Full-shell visual and actual user-window interaction remain pending.
- Live port3000 serves the updated global CSS and delegated WindowControls source (200 with expected markers), not only an isolated build. No Electron main/preload security changes, full rebuild or live Agent restart in this step; existing guarded manager/native/Vite remain in place. `desktop-input-obf.log`: real wrapper/full OBF source Electron regression passed global/embedded no-drag, full canvas, theme/font checks, retained iframe, settings clicks and narrow viewport; peak 2181 MiB. An earlier attempt raced theme-provider commit and detached the settings menu; the harness now waits for light/native mode and two render frames before opening it. All RPCs remained offline, not an authenticated account/model turn.

- `desktop-input-type-comparison.log`: strict isolated WindowControls type-check remains blocked by missing `react-dom` declarations (TS7016); the unchanged HEAD baseline reproduced the same error. Current/baseline peaks 211/210 MiB. No packages installed or shims added; this is not a type-check/build pass.

### V3 shared branding and execution indicators (2026-10-11)

- User authorized product/embedded-Agent use of the Icon Lab V3 six-leaf identity. Geometry and four form/motion families now live in `components/brand/`; Lab re-exports the same implementation. The host plugin (`scripts/bambook-brand-vite.mjs`) redirects only the two DS brand modules, including internal relative imports from `ToolProcessingDots`. All five DS source aliases are shared by serve/build to avoid split providers and stale internal indicators. No model, account, workspace, permission, storage or business-write contracts change.
- Preserve upstream roles rather than animate everything: auth and Agent welcome use static solid marks; splash retains subtle idle motion; About uses transparent strands/flow and the Lab's exact `B A M B O O K` caption metrics. Running read/edit and lightweight tool capsules use compact solid/construct; completed, error, queued and approval indicators retain their existing static semantics. The construct renderer starts with hidden ink/traces in initial markup, has no guide silhouettes, and hides undrawn round caps. Reduced motion settles on complete geometry; offscreen, hidden, paused and finite finished scenes stop requesting frames.
- Native identity assets are generated from the approved SVG, not renamed formats: 1024px PNG, multi-size ICO, ICNS, plus SVG/PNG favicons. User corrected the oversized Dock surface: `generate-bambook-icons.mjs` now scales the app tile to80%, leaving10% transparent margins on all sides (measured alpha bounds102–921 in1024px). Favicon is a separate background-free six-leaf ring, not the app tile; new `bambook-v3-favicon.svg`/32px PNG URLs usev4. The SVG follows light/dark system preference with black/white ink, is declared sizes=any and comes after the PNG fallback. `electron/brandAssets.ts` resolves development and packaged paths. Electron must reopen to read the new native raster; packaged release assets are wired but a full installer build has not been performed.
- Final focused verification: 37 root tests pass (372 MiB), including initially empty markup, draw-in/retraction, four forms, motion lifecycle, host boundaries, workspace, native safe-area and transparent favicon contracts; 78 upstream startup/icon/source-alias tests pass (322 MiB). Shared-brand strict type-check previously passed (278 MiB; brand components unchanged by this asset-only correction). The actual Vite7 build-mode smoke bundles internal `ToolProcessingDots` and emits all18 assets (32 modules); this is not a full application build. Static Lucide check and isolated source-HMR/Host/Origin/method-boundary checks also pass. The deployable host patch was regenerated and reverse-apply checked.
- Offline actual-production edit/read/capsule views pass Chromium (736 MiB) and Electron (920 MiB): genuine path changes, no guide paths, reduced motion, and non-running states without construction. Full wrapper/Agent source fixtures also pass Chromium (1862 MiB) and Electron (2010 MiB), including transparent About, exact caption metrics, theme retention, settings interaction and narrow widths. Lab passes all forms/motions/states and reduced-motion (1161 MiB). Expected unsupported mocked RPC/HMR diagnostics in the full fixtures are not real account/runtime acceptance. No employee profile, credentials, actual filesystem tool execution or live RPCs were inspected.
- Evidence: `docs/design-system/evidence/bambook-brand-integration-2026-10-11/`, `*-executing-tools-{light,dark}.png` (browser1440×900; Electron1440×868 content, 2× raster), plus About/auth/workbench/settings1440×900 and narrow800px, Lab1440×960/390×844, both themes. These are isolated production views, not full-shell or user aesthetic approval; OS-native mouse/Dock appearance, real accounts and installed packages remain outside visual acceptance.
- Live activation: the exact old desktop CLI/Electron pair was stopped and the same `electron-vite dev` relaunched under resource supervision; main/preload rebuilt, Vite3000 and native V3 icon wiring confirmed. Agent manager53488/native53502 were preserved; live1422 serves the V3 favicon, new construction source and internal tool-brand adapter. The complete desktop process family has a 6 GiB sampled-RSS cap and 1 GiB CLI heap (observed after startup around2626 MiB); backend2 GiB/frontend3 GiB guards remain separate. This is not an OS hard quota or a guarantee against the original incident. Initial activation was supervisor82062/CLI82079/Electron82165; the user-requested size/favicon correction then reopened only that verified desktop family under supervisor36887, preserving Agent53502. Log: `tmp/upstream/desktop-brand-live.log`. Guarded generation passes at419 MiB; live3000/1422 isolated HTML-head/asset checks pass at422 MiB, including actual SVG black/white rendering and PNG/SVG transparent corners/center. Size comparison screenshots `native-favicon-size-{light,dark}.png` are720×360 isolated assets, not OS Dock/browser-chrome captures; actual user visual comparison remains pending. No full installer rebuild or authenticated screenshot.

### Remaining acceptance work

1. Expand the bounded history path before claiming complete long-session support; currently only the latest 16 turns are restored with explicit partial status. The older-turn window, session metadata mutation, permission-mode updates and several native-only APIs still need real-owner adapters or disabled controls. Local HTTP, streamed rendering, selected-session refresh recovery, and process-restart recovery are now proven.
2. Adapt or explicitly disable unsupported native-only features; validate skills/plugins, attachments and account-import UI without claiming real authorization was tested. Upstream Codex subscription support is not universal ChatGPT-plan/API entitlement.
3. Capture and inspect genuine Bambook integration screenshots; earlier isolated/upstream screenshots are not full-shell visual acceptance. Report functionality, interaction and visual status separately.

Personal local Agent sessions remain separate from Bambook's server-owned business sessions, permissions, approvals and audit. This experiment grants no business-data write bridge.

## 3. Agent Run Loop

A real Bambook Agent run follows this structure:

1. Authenticate actor
2. Resolve `ActorContext`
3. Load session state from backend
4. Load relevant user, company, and task memory
5. Understand intent
6. Plan required reads/actions
7. Retrieve knowledge and business objects
8. Select tools
9. Check tool permission and risk
10. Execute allowed tools
11. Create approval requests for risky tools
12. Write `AgentToolRun` audit records
13. Update workspace state/events
14. Save user and model messages
15. Save durable Agent memory when appropriate
16. Return response to the user

The model may help plan and summarize, but the backend runtime owns execution.

## 4. Tool Layer

Bambook has two related but different surfaces:

1. Internal application APIs may be numerous and module-specific.
2. Agent-facing tools must be few, semantic, stable, and composable.

Do not expose every internal API or every new user scenario as a new Agent tool. Tool sprawl makes the Agent worse, because the first task becomes selecting from a large pile of narrow operations.

The preferred Agent-facing shape is:

- `*.query`: find candidates, lists, counts, filters, and sorted pages.
- `*.get`: read one full business object by stable id or unique identifier.
- `*.expand`: expand the context around one resolved object with explicit `include` fields.
- `*.draft`: prepare a proposed write or external action without committing it.
- `*.execute`: perform an approved action.

Current domain primitives should converge toward:

- `relations.query`
- `relations.get`
- `relations.expand`
- `products.query`
- `products.get`
- `products.expand`
- `orders.query`
- `orders.get`
- `orders.expand`
- `knowledge.search`
- `email.query`
- `email.draft`
- `email.execute`

Example:

```json
{
  "tool": "relations.expand",
  "input": {
    "id": "panda001",
    "include": ["profile", "contacts", "people", "orders", "emails", "notes"]
  }
}
```

`expand` is where domain context grows. For example, finding a company contact should not require a narrow `relations.contacts` tool. The planner should resolve the company with `relations.query`, then call `relations.expand` with `include: ["profile", "contacts", "people"]`.

Tools must declare:

- `id`
- `scope`
- `risk`
- input schema
- output schema
- allowed roles
- approval behavior
- audit behavior

Low-risk read tools may execute directly. Write tools and external-action tools require stricter checks. High-risk tools, such as sending email or changing financial/business records, must support approval before execution.

Narrow tools are allowed only as temporary implementation shims behind a domain primitive. They should not remain in the Agent-facing manifest unless they represent a durable domain operation.

## 5. Permissions

Agent never bypasses Bambook permissions.

The Agent acts as the current user unless explicitly running a system job. Every tool call must check:

- actor role
- department
- tool scope
- resource ACL
- risk level
- approval requirement

For example, if Kevin is owner, the Agent can inspect digital archives through `products.*` tools. A viewer may be allowed to search or count products but not modify them.

## 6. Knowledge and Business Retrieval

There are two different retrieval paths:

1. Knowledge retrieval: documents, policies, imported files, company memory.
2. Business retrieval: orders, product assets, relations, emails, system records.

Business questions should prefer structured tools over text RAG.

Example:

User asks: "系统里有多少条面料信息？"

Correct path:

1. Intent: product archive count
2. Tool: `products.query` with `aggregate: "count"` or an internal compatibility count handler behind the product domain primitive
3. Output: exact database count
4. Model: explain result in natural language

Incorrect path:

1. Search text snippets
2. Hope a context chunk contains a count
3. Let model infer the answer

## 7. Application Operation

The Agent must be able to operate Bambook through backend tools, not by pretending to click UI.

For durable business actions, UI automation is not the primary path. The primary path is structured backend tools that use the same domain services as the UI.

The workspace UI should display:

- current task
- opened business object
- tool calls
- intermediate results
- generated drafts
- required confirmations
- approval state
- final changes

The workspace is therefore an Agent work surface, not a decorative browser panel.

## 8. Email and Automation

Email automation is a high-risk capability.

The correct path is:

1. `email.search` reads messages
2. `email.draftReply` prepares a draft
3. user or approval policy reviews
4. `email.send` sends only after permission and approval
5. `AgentToolRun` and `AuditLog` record the action

The Agent must not silently send external communication.

## 9. Current Implementation Status

Current status:

- Agent identity, roles, tool scopes, and database schema exist.
- `AgentSession` and `AgentMessage` exist.
- `AgentTool`, `AgentToolPermission`, and `AgentToolRun` exist.
- Default tool directory exists.
- AI chat uses backend Agent Runtime session preparation.
- Production API exposes data-source truth through `/api/agent/status`.
- Agent-facing MCP manifest is converging on `products.query/get/expand`, `orders.query/get/expand`, `relations.query/get/expand`, `knowledge.search`, and `entities.search/hydrate`.
- Internal compatibility handlers such as `products.count`, `dictionary.query`, and `records.query` still exist for older planner paths and regression safety, but they are no longer the preferred Agent-facing tool contract.
- Tool calls return `ToolResult` context and record `AgentToolRun` plus `AuditLog` where a real `UserAccount` is resolved.

Still incomplete:

- planner is still rule-first and not yet a true long-task task graph
- write tools are not yet organized as `draft -> approval -> execute`
- `AgentToolPermission` is not yet the primary live permission source for every tool call
- approval flow is not yet connected to live tool execution
- workspace event stream is not yet the main Agent work surface
- planner still needs to evolve from rule-first follow-ups into a durable task graph with resumable state

## 10. Required Next Architecture Step

The next implementation step is to introduce a central `AgentRuntime` service:

- owns session load/save
- owns planning state
- owns tool registry
- owns tool execution
- owns approvals
- owns audit writes
- emits workspace events
- calls the model only as one component of the run

After that, AI chat becomes one client of Agent Runtime, not the runtime itself.
