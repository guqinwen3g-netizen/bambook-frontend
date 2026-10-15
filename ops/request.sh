set -u
echo mail-test-1
sudo python3 - <<'PY'
import smtplib,imaplib,ssl,time,email.message,uuid
acc=dict(l.split() for l in open('/srv/bambook-dev/shared/mail-accounts.txt') if l.strip())
ctx=ssl.create_default_context();ctx.check_hostname=False;ctx.verify_mode=ssl.CERT_NONE
def send(frm,to,subj,mail_from=None):
    m=email.message.EmailMessage();m['From']=mail_from or frm;m['To']=to;m['Subject']=subj;m['Message-ID']='<%s@sylway.cloud>'%uuid.uuid4();m.set_content('bambook-dev 邮件联通测试')
    s=smtplib.SMTP('127.0.0.1',587,timeout=15);s.starttls(context=ctx);s.login(frm,acc[frm])
    try: s.send_message(m);r='sent'
    except Exception as e: r='rejected: '+str(e)[:160]
    s.quit();return r
tag=str(int(time.time()))
print('sales->customer:',send('sales@sylway.cloud','customer-demo@sylway.cloud','询价 '+tag))
print('customer->sales:',send('customer-demo@sylway.cloud','sales@sylway.cloud','回复 询价 '+tag))
print('spoof From/sender mismatch:',send('customer-demo@sylway.cloud','sales@sylway.cloud','spoof','finance@sylway.cloud'))
print('external gmail:',send('sales@sylway.cloud','someone@gmail.com','ext '+tag))
try:
    s=smtplib.SMTP('127.0.0.1',587,timeout=10);s.starttls(context=ctx);s.login('sales@sylway.cloud','wrong');print('bad password: ACCEPTED (bad)')
except smtplib.SMTPAuthenticationError: print('bad password: rejected')
time.sleep(3)
for u in ['customer-demo@sylway.cloud','sales@sylway.cloud']:
    i=imaplib.IMAP4_SSL('127.0.0.1',993,ssl_context=ctx);i.login(u,acc[u]);i.select('INBOX')
    t,d=i.search(None,'SUBJECT',tag);print('imap',u,'hits for tag:',len(d[0].split()))
    print('  folders:',' '.join(x.decode().split(' "/" ')[-1] for x in i.list()[1]))
    i.logout()
PY
echo '== queue'; sudo postqueue -p | tail -3
echo '== log'; sudo journalctl -u postfix -n 12 --no-pager | grep -E 'status=|reject|error' | sed -E 's/to=<[^>]*gmail[^>]*>/to=<ext>/' | cut -c1-220
