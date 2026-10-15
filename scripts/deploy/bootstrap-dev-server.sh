#!/bin/bash
# Bambook development server: idempotent administrator setup. Run as root on the Tencent development host only.
# Never prints generated secrets. Existing configuration, database and credentials are preserved.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
deploy_user=bambook-deploy
root=/srv/bambook-dev
etc=/etc/bambook-dev
database=panda_hub_dev
db_role=bambook_dev
public_origin=${BAMBOOK_DEV_ORIGIN:-https://bambook-dev.sylway.cloud}
node_major=22
id "$deploy_user" >/dev/null

# Memory headroom for npm ci / type checks on a 4 GB host.
if [[ -z "$(swapon --show --noheadings)" ]]; then
  [[ -f /swapfile ]] || { fallocate -l 2G /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx postgresql curl ca-certificates openssl >/dev/null
if [[ "$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')" != "$node_major" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${node_major}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

# Directories: releases are owned by the delivery account; persistent runtime data lives in shared/.
install -d -m 0755 -o "$deploy_user" -g "$deploy_user" "$root" "$root/releases" "$root/shared"
install -d -m 0700 -o "$deploy_user" -g "$deploy_user" "$root/shared/mist-files" "$root/shared/ai-subscriptions" "$root/shared/logs" \
  "$root/shared/uploads" "$root/shared/private-files" "$root/shared/storage" "$root/shared/data" "$root/shared/output"
install -d -m 0750 -o root -g "$deploy_user" "$etc"

# Dedicated development database and role. The password is generated once and only written to backend.env.
systemctl enable --now postgresql >/dev/null
if [[ ! -f "$etc/backend.env" ]]; then
  password=$(openssl rand -hex 24)
  if sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='$db_role'" | grep -qx 1; then
    printf "alter role %s with login password '%s';\n" "$db_role" "$password" | sudo -u postgres psql -q -v ON_ERROR_STOP=1 >/dev/null
  else
    printf "create role %s with login password '%s';\n" "$db_role" "$password" | sudo -u postgres psql -q -v ON_ERROR_STOP=1 >/dev/null
  fi
  umask 027
  cat > "$etc/backend.env" <<ENV
DATABASE_URL=postgresql://$db_role:$password@localhost:5432/$database
JWT_SECRET=$(openssl rand -hex 48)
MIST_HOST=127.0.0.1
MIST_PORT=8082
MIST_LOCAL_WORKSPACE=0
MIST_CORS_ORIGINS=$public_origin
MIST_FILES_DIR=$root/shared/mist-files
BAMBOOK_AI_SUBSCRIPTION_DIR=$root/shared/ai-subscriptions
AUTH_REQUIRE_EMAIL_VERIFY=0
TZ=Asia/Shanghai
ENV
  umask 022
  unset password
fi
# Main API settings; appended only when missing, so existing values (and secrets) are preserved on re-runs.
ensure_env() { grep -q "^$1=" "$etc/backend.env" || printf '%s=%s\n' "$1" "$2" >> "$etc/backend.env"; }
ensure_env NODE_ENV production
ensure_env PORT 8081
ensure_env BAMBOOK_HOST 127.0.0.1
ensure_env BAMBOOK_PUBLIC_BASE_URL "$public_origin"
ensure_env BAMBOOK_UPLOAD_DIR "$root/shared/uploads"
ensure_env BAMBOOK_PRIVATE_FILES_DIR "$root/shared/private-files"
ensure_env SYSTEM_CONFIG_ENCRYPTION_KEY "$(openssl rand -hex 32)"
ensure_env BAMBOOK_COOKIE_SECRET "$(openssl rand -hex 32)"
ensure_env BAMBOOK_CODEX_SUBSCRIPTION 1
# Development host never syncs with the production PDML system.
ensure_env PDML_SYNC_DISABLED true
chown root:"$deploy_user" "$etc/backend.env"; chmod 0640 "$etc/backend.env"
if ! sudo -u postgres psql -tAc "select 1 from pg_database where datname='$database'" | grep -qx 1; then
  sudo -u postgres createdb -O "$db_role" "$database"
fi

# Fixed service unit; the delivery account may only restart or stop it.
cat > /etc/systemd/system/bambook-dev.service <<UNIT
[Unit]
Description=Bambook development backend (main API)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=$deploy_user
Group=$deploy_user
WorkingDirectory=$root/current/server
EnvironmentFile=$etc/backend.env
ExecStart=/usr/bin/node node_modules/tsx/dist/cli.mjs src/index.ts
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$root/shared
MemoryMax=1536M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable bambook-dev.service >/dev/null
cat > /etc/sudoers.d/bambook-deploy <<SUDO
$deploy_user ALL=(root) NOPASSWD: /usr/bin/systemctl restart bambook-dev.service, /usr/bin/systemctl stop bambook-dev.service
SUDO
chmod 0440 /etc/sudoers.d/bambook-deploy
visudo -cf /etc/sudoers.d/bambook-deploy >/dev/null

# Same-origin web entry: static frontend from the active release, /api to the backend. Loopback only; Cloudflare Tunnel connects here.
cat > /etc/nginx/sites-available/bambook-dev <<'NGINX'
server {
    listen 127.0.0.1:8080;
    server_name _;
    root /srv/bambook-dev/current/web;
    client_max_body_size 64m;
    location /api/ {
        proxy_pass http://127.0.0.1:8081;
        # 管理员登录响应携带较大的 Set-Cookie，默认 4k/8k 头缓冲会 502。
        proxy_buffer_size 64k;
        proxy_buffers 8 64k;
        proxy_busy_buffers_size 128k;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }
    location / {
        add_header Cache-Control "no-cache";
        try_files $uri /index.html;
    }
}
NGINX
ln -sfn /etc/nginx/sites-available/bambook-dev /etc/nginx/sites-enabled/bambook-dev
rm -f /etc/nginx/sites-enabled/default
nginx -t -q
systemctl enable nginx >/dev/null
systemctl reload-or-restart nginx

# Daily compressed database backup, 7 days retained.
install -d -m 0700 -o postgres -g postgres /var/backups/bambook-dev
cat > /etc/cron.daily/bambook-dev-backup <<'CRON'
#!/bin/sh
set -e
cd /var/backups/bambook-dev
sudo -u postgres pg_dump -Fc panda_hub_dev > "panda_hub_dev-$(date +%Y%m%d).dump"
find . -name 'panda_hub_dev-*.dump' -mtime +7 -delete
CRON
chmod 0755 /etc/cron.daily/bambook-dev-backup

echo 'Bambook development host prepared: database, backend.env, service unit, sudo rule, nginx 127.0.0.1:8080, swap, daily backup.'
