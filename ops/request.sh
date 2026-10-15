set -u
echo mail-probe-2
echo '== apt'; apt-cache policy postfix dovecot-core dovecot-imapd dovecot-lmtpd opendkim 2>/dev/null | grep -E '^[a-z]|Candidate'
echo '== net'; for u in https://github.com https://deb.debian.org https://acme-v02.api.letsencrypt.org/directory; do printf '%s ' $u; curl -s -o /dev/null -w '%{http_code}\n' --max-time 8 $u || echo fail; done
echo '== cloudflared'; systemctl is-active cloudflared 2>/dev/null; sudo ls /etc/cloudflared 2>/dev/null; sudo grep -rlE 'CF_API|CLOUDFLARE_API|api_token' /etc /srv/bambook-dev/shared 2>/dev/null | head
echo '== ingress'; sudo sh -c 'cat /etc/cloudflared/config.yml 2>/dev/null' | grep -vi -E 'secret|token|credentials' | head -20
echo '== shared'; sudo ls -la /srv/bambook-dev/shared | head -20
