set -u
echo "current: $(readlink -f /srv/bambook-dev/current)"
ls -1t /srv/bambook-dev/releases | head -4
for s in bambook-dev mist; do echo "$s: $(systemctl is-active $s 2>/dev/null)"; done
echo "health: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/health || true)"
echo "public: $(curl -s -o /dev/null -w '%{http_code}' https://bambook-dev.sylway.cloud/ || true)"
cur=$(readlink -f /srv/bambook-dev/current); echo "stamp: $(test -f $cur/server/.deps-stamp && echo yes || echo no)"
sudo test -f /srv/bambook-dev/shared/test-accounts.txt && sudo sed -E 's/[^[:space:]:=|,]/x/g' /srv/bambook-dev/shared/test-accounts.txt | head -12
sudo journalctl -u bambook-dev-receiver --since "40 min ago" --no-pager 2>/dev/null | grep -iE "reus|deps|npm ci|activated|switch" | tail -8
