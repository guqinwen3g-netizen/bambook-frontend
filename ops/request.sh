set -u
date -u
echo check-deploy-8207fc4
echo '== current'; readlink -f /srv/bambook-dev/current
ls -1dt /srv/bambook-dev/releases/*/ | head -4
echo '== stamp'; cat /srv/bambook-dev/current/server/.deps-stamp 2>&1 | cut -c1-30
echo '== services'; systemctl is-active bambook-dev bambook-dev-mist postfix dovecot
curl -s -o /dev/null -w 'health %{http_code}\n' --max-time 5 http://127.0.0.1:8081/api/health
curl -s -o /dev/null -w 'public %{http_code}\n' --max-time 10 https://bambook-dev.sylway.cloud/
echo '== marker'; ls /srv/bambook-dev/.activation.json 2>&1
echo '== build procs'; ps -eo etime,args | grep -E 'npm ci|tsc|prisma' | grep -v grep | cut -c1-120
