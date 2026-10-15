request: 656e975e5b029c4383bade0febd95df82356b43a
exit: 0
seconds: 18
finished: 2026-10-15T16:56:50Z
run: https://github.com/guqinwen3g-netizen/bambook-main/actions/runs/38773144079
---
mail-test-1
sales->customer: sent
customer->sales: sent
spoof From/sender mismatch: rejected: {'sales@sylway.cloud': (553, b'5.7.1 <finance@sylway.cloud>: Sender address rejected: not owned by user customer-demo@sylway.cloud')}
external gmail: rejected: {'someone@gmail.com': (550, b'5.7.1 <someone@gmail.com>: Recipient address rejected: external delivery is not enabled on bambook-dev yet')}
bad password: rejected
imap customer-demo@sylway.cloud hits for tag: 1
  folders: Drafts Sent Trash Junk INBOX
imap sales@sylway.cloud hits for tag: 1
  folders: Drafts Sent Trash Junk INBOX
== queue
Mail queue is empty
== log
Oct 16 00:56:35 VM-0-17-ubuntu postfix/submission/smtpd[206695]: NOQUEUE: reject: RCPT from localhost[127.0.0.1]: 550 5.7.1 <someone@gmail.com>: Recipient address rejected: external delivery is not enabled on bambook-dev
Oct 16 00:56:35 VM-0-17-ubuntu postfix/lmtp[206702]: 3AA0FA9524: to=<customer-demo@sylway.cloud>, relay=mail.sylway.cloud[private/dovecot-lmtp], delay=0.05, delays=0.01/0.01/0.01/0.02, dsn=2.0.0, status=sent (250 2.0.0 <
Oct 16 00:56:35 VM-0-17-ubuntu postfix/lmtp[206705]: 3E551A9526: to=<sales@sylway.cloud>, relay=mail.sylway.cloud[private/dovecot-lmtp], delay=0.05, delays=0.01/0.01/0.01/0.02, dsn=2.0.0, status=sent (250 2.0.0 <sales@sy
