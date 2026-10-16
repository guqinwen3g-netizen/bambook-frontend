set -uo pipefail
# codex/mist-mail-transport: read-only mail service check. Never prints passwords.
echo '== services'; systemctl is-active dovecot postfix bambook-dev bambook-dev-mist 2>&1 | paste -sd' '
echo '== listeners (mail)'; ss -ltn | awk '{print $4}' | grep -E ':(25|587|143|993)$' | sort | paste -sd' '
echo '== dovecot accounts'; sudo -n cut -d: -f1 /etc/dovecot/users | paste -sd' '; echo "count=$(sudo -n wc -l </etc/dovecot/users)"
ACC=/srv/bambook-dev/shared/mail-accounts.txt
echo "== secret file: exists=$(sudo -n test -f $ACC && echo yes || echo no) mode=$(sudo -n stat -c %a $ACC 2>/dev/null) owner=$(sudo -n stat -c %U $ACC 2>/dev/null) lines=$(sudo -n wc -l <$ACC 2>/dev/null)"
echo '== imap login health (993, self-signed accepted, password never printed)'
sudo -n python3 - "$ACC" <<'PY'
import imaplib, ssl, sys
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
for line in open(sys.argv[1]):
    parts = line.split()
    if len(parts) != 2: continue
    user, pw = parts
    try:
        m = imaplib.IMAP4_SSL('127.0.0.1', 993, ssl_context=ctx); m.login(user, pw)
        typ, data = m.status('INBOX', '(MESSAGES UIDVALIDITY UIDNEXT)')
        typ2, boxes = m.list()
        print(user, 'LOGIN_OK', data[0].decode(), 'folders=%d' % len(boxes or []))
        m.logout()
    except Exception as e:
        print(user, 'LOGIN_FAIL', type(e).__name__)
PY
echo '== smtp submission 587 EHLO/STARTTLS (no auth)'
python3 - <<'PY'
import smtplib, ssl
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
try:
    s = smtplib.SMTP('127.0.0.1', 587, timeout=10); s.ehlo(); s.starttls(context=ctx); code, msg = s.ehlo(); print('587 STARTTLS_OK auth=' + ('AUTH' in msg.decode()).__str__()); s.quit()
except Exception as e: print('587 FAIL', type(e).__name__)
PY
echo '== runtime layout'; readlink -f /srv/bambook-dev/current; node -v 2>&1; ls /srv/bambook-dev/current | head -20
C=$(readlink -f /srv/bambook-dev/current)
ls "$C/server" 2>/dev/null | head -30
for p in imap-simple imap mailparser nodemailer tsx ts-node typescript; do printf '%s=%s ' $p "$(test -d $C/server/node_modules/$p && node -p "require('$C/server/node_modules/$p/package.json').version" 2>/dev/null || echo missing)"; done; echo
systemctl cat bambook-dev-mist 2>/dev/null | grep -E 'ExecStart|WorkingDirectory|User=|EnvironmentFile' | sed 's/=.*\(Environment\)/=\1/'
echo '== github reachability'; curl -s -o /dev/null -w '%{http_code}\n' --max-time 8 https://codeload.github.com/ || echo unreachable
which git chromium chromium-browser google-chrome 2>/dev/null | paste -sd' '
