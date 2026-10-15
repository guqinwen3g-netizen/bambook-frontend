set -u
date -u
echo check-deploy-bd83727
echo '== current'; readlink -f /srv/bambook-dev/current
ls -1dt /srv/bambook-dev/releases/*/ | head -3
echo '== services'; systemctl is-active bambook-dev bambook-dev-mist postfix dovecot
curl -s -o /dev/null -w 'health %{http_code}\n' --max-time 5 http://127.0.0.1:8081/api/health
curl -s -o /dev/null -w 'public %{http_code}\n' --max-time 10 https://bambook-dev.sylway.cloud/
echo '== marker'; ls -la /srv/bambook-dev/.activation.json 2>&1
echo '== timings'; sudo journalctl --since '-3h' --no-pager 2>/dev/null | grep -E '\[release \+|activat|rollback|timeout' | tail -60 | cut -c1-220
