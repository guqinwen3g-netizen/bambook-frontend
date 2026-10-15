set -u
date -u
echo check-4
echo '== current'; readlink -f /srv/bambook-dev/current
ls -1dt /srv/bambook-dev/releases/*/ | head -3
echo '== services'; systemctl is-active bambook-dev bambook-dev-mist
curl -s -w '\nhealth %{http_code}\n' --max-time 5 http://127.0.0.1:8081/api/health | tail -c 300
echo '== processes'; ps -eo pid,etime,args | grep -E 'prisma|npm|tsc|receiver' | grep -v grep | cut -c1-160
