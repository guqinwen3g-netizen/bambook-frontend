set -e
whoami; sudo -n whoami; hostname
systemctl is-active bambook-dev bambook-dev-mist
curl -s -o /dev/null -w 'health %{http_code}\n' http://127.0.0.1:8081/api/health || true
ls /srv/bambook-dev/releases | tail -3
