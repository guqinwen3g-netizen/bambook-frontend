set -euo pipefail
printf 'capacity-baseline UTC '; date -u +%FT%TZ
uname -sr; nproc; free -m; df -Pm / /tmp /srv
cat /proc/pressure/memory /proc/pressure/cpu
printf 'runtimes\n'; node --version; npm --version
for p in systemd-run timeout python3 curl tar git docker; do command -v "$p" || true; done
printf 'cgroup controllers\n'; cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null || true
printf 'services\n'; systemctl show bambook-dev bambook-dev-mist -p Id -p ActiveState -p MemoryCurrent -p MainPID --no-pager
printf 'current\n'; readlink -f /srv/bambook-dev/current
printf 'source availability\n'; for p in package.json package-lock.json server/package.json server/package-lock.json tsconfig.mist.json .nvmrc dev-ui-preview/mist-atelier/app/main.tsx server/src/mist/server.ts .github/workflows/mist.yml; do test ! -f "/srv/bambook-dev/current/$p" || echo "$p present"; done
printf 'deployment disk use\n'; du -sm /srv/bambook-dev/current/ /srv/bambook-dev/releases /srv/bambook-dev/shared 2>/dev/null || true
printf 'listening ports\n'; ss -ltn | head -15
printf 'health latency\n'; for p in 8081 8082; do curl --max-time 5 -s -o /dev/null -w "port=$p code=%{http_code} seconds=%{time_total}\n" "http://127.0.0.1:$p/api/health" || true; done
printf 'sudo/cgroup availability\n'; sudo -n true && echo sudo-ok
systemd --version | head -1
