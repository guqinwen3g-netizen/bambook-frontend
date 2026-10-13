# Bambook Mac mini Ops Panel Runbook

This runbook installs the independent Bambook data center ops panel on the Mac mini. The panel is intended for non-IT operators and remote agents. It exposes status checks and a small whitelist of safe operations; it does not expose arbitrary shell access.

## Service

| Item | Value |
|:---|:---|
| Local URL | `http://127.0.0.1:8088/ops` |
| Public URL | `https://ops.jiangsupanda.com/ops` |
| LaunchAgent | `com.bambook.ops-panel` |
| Auto-update LaunchAgent | `com.bambook.ops-panel-auto` |
| Public probe LaunchAgent | `com.bambook.public-probe` |
| Runtime dir | `~/bambook-main-api/ops-panel` |
| Action log | `/tmp/bambook-ops-actions.log` |
| Process log | `/tmp/bambook-ops-panel.log` |
| Public probe log | `/tmp/bambook-public-probe.log` |

## Required Secret

Add a strong token on the Mac mini only. Do not commit this value.

```sh
cd ~/bambook-main-api
touch .env.local
grep -q '^BAMBOOK_OPS_ADMIN_TOKEN=' .env.local || printf '\nBAMBOOK_OPS_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 24)" >> .env.local
grep '^BAMBOOK_OPS_ADMIN_TOKEN=' .env.local
```

The browser sends the token in `X-Bambook-Ops-Token`. The page stores it in browser `localStorage` on the admin machine.

## New Environment: Database Bootstrap (step 0)

★ Added 2026-09-27. Authority: `docs/交付目标与验收标准-2026-09-20.md` §9 **B212** (cause) and **B259** (reachability).

- **Do not start a brand-new environment with `npx prisma migrate deploy`.** It cannot build an empty
  database: the migration history never contained the original `CREATE TABLE` for `FabricProfile`
  (that table came from a historical `db push`), so the first `ALTER` referencing it fails with
  `relation "FabricProfile" does not exist`. This is B212, and its exit ② (back-filling the history)
  is still open.
- The provisioning tool is **`scripts/bootstrap-fresh-db.mjs`**, and it ships **in the git repository,
  not inside this deployable package** (that is exactly what B259 registers). So step 0 has to be run
  from a repo checkout that contains `server/` next to `scripts/`:

  ```sh
  set -a; . server/.env.local; set +a              # or export DATABASE_URL explicitly
  node scripts/bootstrap-fresh-db.mjs --dbname <new_db>        # add --seed for the demo dataset
  ```

  It builds the schema (`db push`), marks the existing migrations as applied (baseline), then *really*
  runs `migrate deploy` as its own judgement. Success looks like: `No pending migrations to apply.`
  plus bookkeeping `72 / 72`. It refuses to run against any database that already holds product
  tables (`exit 2`), asserts `current_database()` at every step, and requires the database owner to be
  the application role — so it cannot be pointed at a live database by accident.
- After step 0, point `DATABASE_URL` at that database. From then on the normal upload-and-deploy flow
  works, because the ledger is complete and `migrate deploy` only has increments to apply.
- ⚠️ **Still open (B259, needs an owner decision):** getting a first environment up currently requires a
  repo checkout on hand. Two exits were written down and neither was chosen:
  **(A)** back-fill the earliest `CREATE TABLE` migration so `migrate deploy` works from zero (touches
  migration history); **(B)** ship this script inside the package and teach the upload flow to see it
  (touches deploy behaviour — the receiver today only copies from `server/`, and its copy filter does
  not accept `.mjs`).

## One-Time Install On Mac mini

Run this after the latest repository code has been pulled into `~/bambook-main-api`.

```sh
cd ~/bambook-main-api
chmod +x scripts/run-ops-panel.sh scripts/ops/*.sh

mkdir -p ~/Library/LaunchAgents
sed "s|CHANGE_ME_HOME|$HOME|g" scripts/com.bambook.ops-panel.plist > ~/Library/LaunchAgents/com.bambook.ops-panel.plist

launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.bambook.ops-panel.plist 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.bambook.ops-panel.plist
launchctl kickstart -k "gui/$(id -u)/com.bambook.ops-panel"

sleep 5
launchctl list | grep com.bambook.ops-panel
curl -sS http://127.0.0.1:8088/api/status -H "X-Bambook-Ops-Token: $(grep '^BAMBOOK_OPS_ADMIN_TOKEN=' .env.local | cut -d= -f2-)"
```

## Optional Auto-Update Agent

Install this once if you want the Mac mini to check GitHub `main` every minute and deploy panel changes automatically after a developer or agent pushes code.

```sh
cd ~/bambook-main-api
chmod +x scripts/ops/*.sh

mkdir -p ~/Library/LaunchAgents
sed "s|CHANGE_ME_HOME|$HOME|g" scripts/com.bambook.ops-panel-auto.plist > ~/Library/LaunchAgents/com.bambook.ops-panel-auto.plist

launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.bambook.ops-panel-auto.plist 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.bambook.ops-panel-auto.plist
launchctl kickstart -k "gui/$(id -u)/com.bambook.ops-panel-auto"

launchctl list | grep com.bambook.ops-panel-auto
tail -n 80 /tmp/bambook-ops-panel-auto.log
```

## Cloudflare Route

Add a public hostname/path rule in the existing Bambook Tunnel:

- Hostname: `ops.jiangsupanda.com`
- Path: empty
- Service: `http://127.0.0.1:8088`

The older `jiangsupanda.com/bambook/ops` route is retired and should remain `http_status:404` in Cloudflare. Do not re-add the OPS panel under the main `jiangsupanda.com` hostname; otherwise it can conflict with the `/bambook` knowledge API route.

## Optional Public Probe Agent

Install this once if you want launchd to record public status-code probes every five minutes. It checks the canonical API, knowledge API, OPS panel, and retired routes.

```sh
cd ~/bambook-main-api
chmod +x scripts/ops/*.sh

mkdir -p ~/Library/LaunchAgents
sed "s|CHANGE_ME_HOME|$HOME|g" scripts/com.bambook.public-probe.plist > ~/Library/LaunchAgents/com.bambook.public-probe.plist

launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.bambook.public-probe.plist 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.bambook.public-probe.plist
launchctl kickstart -k "gui/$(id -u)/com.bambook.public-probe"

tail -n 20 /tmp/bambook-public-probe.log
```

## Whitelisted Actions

The panel can only call scripts under `server/scripts/ops/`:

- `ops-healthcheck.sh`
- `ops-restart-main-api.sh`
- `ops-restart-cloudflare.sh`
- `ops-backup-postgres.sh`
- `ops-deploy-main-api.sh`
- `ops-deploy-panel.sh`
- `ops-demo-seed-dry-run.sh`
- `ops-demo-seed-rollback.sh`
- `ops-public-probe.sh`

Each POST action requires the admin token. Dangerous actions also require an exact confirmation code. Action results are appended to `/tmp/bambook-ops-actions.log`.

## Remote Update Flow

1. Developer or agent pushes code to GitHub.
2. Admin opens `https://ops.jiangsupanda.com/ops`.
3. Admin enters the ops token.
4. Admin clicks `拉取 GitHub 并部署主数据 API`.
5. The Mac mini runs `git fetch`, `git pull --ff-only`, `npm install`, `prisma migrate deploy`, `prisma generate`, `npm run build`, restarts the main API, and checks health.

For panel code changes, either click `更新运维面板自身` after logging in, or install `com.bambook.ops-panel-auto` and let the Mac mini poll GitHub `main` automatically.

## Push-Based Panel Deploy

When GitHub downloads from the Mac mini are unstable, use the push-based endpoint. The developer machine uploads a local tarball to the ops panel; the Mac mini deploys it locally and restarts the panel.

```sh
cd /path/to/Bambook
read -s -p "Ops Password: " OPS_TOKEN; echo
tar --exclude='node_modules' --exclude='.git' --exclude='.playwright-mcp' -czf /tmp/bambook-ops-upload.tar.gz server/ops-panel server/scripts server/docs/ops-panel-runbook.md
curl -sS -m 360 -w '\nHTTP_STATUS:%{http_code}\n' \
  -X POST https://ops.jiangsupanda.com/api/admin/deploy-package \
  -H "Content-Type: application/gzip" \
  -H "X-Bambook-Ops-Token: $OPS_TOKEN" \
  --data-binary @/tmp/bambook-ops-upload.tar.gz
unset OPS_TOKEN
```

## Safety Notes

- Do not add an arbitrary command endpoint.
- Do not show database passwords, Cloudflare tunnel tokens, or `.env` contents in the UI.
- Keep database restore as a manual runbook step until a reviewed rollback workflow exists.
- The ops panel depends on the existing Cloudflare Tunnel. If the tunnel is down, use local Mac mini access or UU remote control to recover `com.cloudflare.bambook.api`.
