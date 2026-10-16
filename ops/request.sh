set -u
cur=$(readlink -f /srv/bambook-dev/current); echo "current: $cur"
sudo journalctl -u bambook-dev-receiver --since "60 min ago" --no-pager 2>/dev/null | grep -iE "reus|deps|activated|switch|npm ci" | tail -6
ls /etc/systemd/system | grep -i bambook
sudo awk -F'\t' 'NR>2{print NR": "$1}' /srv/bambook-dev/shared/test-accounts.txt
sudo sed -n 1p /srv/bambook-dev/shared/test-accounts.txt | sed -E 's/[A-Za-z0-9@._-]{12,}/<redacted>/g'
grep -h "PORT" /srv/bambook-dev/shared/*.env 2>/dev/null | sed -E 's/=.*/=…/' | head; sudo ss -ltnp | grep -E "node|nginx" | awk '{print $4}' | head
