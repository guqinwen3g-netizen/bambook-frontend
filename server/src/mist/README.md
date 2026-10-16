# Mist workspace API

The active Mist frontend is served at 3001; 3131 uses the same source. The API is a typed workspace with separate fulfillment, market, and platform domains. It never imports old Manager UI.

## Local development without a legacy database

From the project root, `npm run dev` or `npm run dev:mist` starts the independent local API at 8082 and the Mist frontend at 3001 together. The frontend starts after the local API is ready. An already healthy local Mist API is reused; an unrelated service occupying 8082 is rejected. Ctrl+C stops only the processes this command started. `npm run dev:mist:ui` starts only the frontend for an already running API.

For API-only work, `npm --prefix server run dev:mist` enables `MIST_LOCAL_WORKSPACE=1` and starts the metadata-polling runner on loopback port 8082. It watches the Mist source and configuration, waits for its own child to close, and then restarts it. It does not depend on native file notification support.

This mode does not construct Prisma or the old AuthRouter. Data, receipts, private attachments, and a persistent 0600 signing key live in `server/private/mist-local/`, which is ignored by Git. State and command receipts are committed in one atomic JSON replacement. A failed write preserves the previous file. Corrupt existing files are not reset.

`GET /api/mist/session` establishes the signed HttpOnly local-operator session. `POST /api/mist/session` accepts only an allowlisted profileId to switch between local-operator and local-reviewer. These are local workflow test identities, not production organizational accounts. Production mode, non-loopback binding, cross-site origins, unsigned/invalid/expired identities are rejected. An expired cookie can be cleared and re-entered without an old account library. Passive session checks preserve unsaved forms when identity and permissions are unchanged; switching identity, changed permissions, or a failed check invalidates the prior context.

Outside local mode, the standalone API uses the existing real account/permission checks and Prisma workspace tables. Local cookies are not accepted by that mode. The model service reuses existing server-side LLM configuration without exposing keys or activating old business tools.

## Endpoints under `/api/mist`

- `GET /workspaces/default`, `GET /workspaces`, `POST /workspaces` with `{name,slug?,seed?:"demo"|"empty"}`, and `GET /workspaces/:id`.
- `GET /workspaces/archived`, `POST /workspaces/:id/archive`, and `POST /workspaces/:id/restore` provide owner-only, reversible archive with `{requestId,expectedRevision}`. Pending approvals block archival; records and attachments are retained. When the last active workspace is archived, an empty successor is created atomically and reused by the default entry.
- `POST /workspaces/:id/commands` with `{requestId,expectedRevision,command:{type,payload}}`; typed domain commands only, no whole-state overwrite.
- `GET /workspaces/:id/receipts/:requestId`.
- `POST /workspaces/:id/files` with multipart file/requestId/expectedRevision, max50MiB; `GET /workspaces/:id/files/:fileId` returns real private bytes.
- `GET /reviews`; `POST /reviews/:workspaceId/:reviewId` with original requestId, expectedRevision, decision and note; `GET /reviews/:workspaceId/receipts/:requestId`.
- `GET /reviews/:workspaceId/:reviewId/files/:fileId` is restricted to the frozen evidence list and the actual authorized reviewer.
- `GET /workspaces/:id/assistant/status`, `POST /workspaces/:id/assistant` with message/history/explicit sourceIds. Read-only, owner plus ai:chat required. No configured provider yields an explicit error. Status reflects the shared platform model (platform subscription or server API chain), not personal connections.
- ChatGPT subscription connections (Codex backend, off unless `BAMBOOK_CODEX_SUBSCRIPTION=1`). Two credential subjects, never mixed:
  - **Platform model** (owner / super-admin only): `GET /ai/platform-model`, `POST /ai/platform-model/chatgpt/login`, `GET /ai/platform-model/chatgpt/login/:loginId`, `POST /ai/platform-model/chatgpt/disconnect`. Shared by all platform AI (quote review, summaries, reconciliation, business Q&A) regardless of the requesting user. Test phase: an admin's ChatGPT subscription; production: enterprise API (`ARK_*` / `BAMBOOK_LLM_BACKUP*`), which is also the fallback when the platform subscription fails.
  - **Personal connection** (ai:chat, identity from session): `GET /ai/subscriptions`, `POST /ai/subscriptions/chatgpt/login`, `GET /ai/subscriptions/chatgpt/login/:loginId`, `POST /ai/subscriptions/chatgpt/disconnect`. Reserved for the future on-device work assistant; never used by platform AI.
  - Device code login returns `userCode` + `https://auth.openai.com/codex/device`. Tokens are stored per subject under `server/private/ai-subscriptions` (0600, override `BAMBOOK_AI_SUBSCRIPTION_DIR`) and never returned or logged. Model `BAMBOOK_CODEX_MODEL` (default `gpt-6-luna`). Per-feature reasoning (`server/src/ai/platformModel.ts`): quote review `max`, Q&A `medium`, summary `medium`, reconciliation `high`; override with `BAMBOOK_PLATFORM_REASONING_<PROFILE>` (e.g. `_QUOTE_REVIEW=high`). Requests use a 180 s timeout while the platform subscription is connected. Protocol follows OpenBitFun (MIT) `subscription_auth/codex.rs`; only login, refresh and text completion are ported.

Workspace: `{id,ownerId,name,revision,state}`. Receipt: `{requestId,revision,result}`. Commands reload authority, enforce owner or narrowly assigned review access, check original receipts, then persist state and receipt together. Identical requests replay once; changed input with the same requestId conflicts. Named workspace creation uses its stable slug and creation receipt. Local storage in the browser holds selected IDs and recovery intent, not authoritative business records.

Concurrent saves: a command sent against an older `expectedRevision` is re-run on the latest state in a fresh transaction (authority, membership and business rules re-checked) only when every intervening revision left a server marker receipt (`mist-revision:<n>`, reserved prefix) whose written positions do not overlap this command's writes (fields; id-keyed records as a whole). Same-record writes, `decide/confirm/issue/release/document` commands and development notice generation, unmarked revisions (member, archive, review decisions) and gaps over 20 still fail with `REVISION_CONFLICT`. Serialization failures retry at most 3 transactions without sleeping; the original request receipt stays unchanged.

The new workspace uses the Mist handoff sample data only when explicitly seeded as demo. It does not migrate the old simulation library. Formal shipping/customs/payment actions remain recorded facts; this service does not submit external filings or transfers.

The October 13 live model probe used synthetic text without selected business sources. The configured Ark endpoint rejected it because its coding subscription expired. This now returns the redacted `MIST_ASSISTANT_MODEL_UNAVAILABLE` error. Provider settings and credentials were not changed; “configured” is not a claim of successful connection.
