request: 1ba910c0f1703deadea8d02273fcd44fe76bcfec
request-sha256: 7bd14d327c7d833766ebda4c5819c7ab94b82984a23cdb54ec2fbb23ff8def78
exit: 1
seconds: 5
finished: 2026-10-16T19:19:05Z
run: https://github.com/guqinwen3g-netizen/bambook-main/actions/runs/38953990437
---
== services
active active active active
== listeners (mail)
127.0.0.1:143 127.0.0.1:25 127.0.0.1:587 127.0.0.1:993
== dovecot accounts
sales@sylway.cloud finance@sylway.cloud customer-demo@sylway.cloud factory-demo@sylway.cloud
bash: line 5: /etc/dovecot/users: Permission denied
count=
bash: line 7: /srv/bambook-dev/shared/mail-accounts.txt: Permission denied
== secret file: exists=yes mode=600 owner=root lines=
== imap login health (993, self-signed accepted, password never printed)
sales@sylway.cloud LOGIN_OK INBOX (MESSAGES 1 UIDNEXT 2 UIDVALIDITY 1792083395) folders=5
finance@sylway.cloud LOGIN_OK INBOX (MESSAGES 0 UIDNEXT 1 UIDVALIDITY 1792178343) folders=5
customer-demo@sylway.cloud LOGIN_OK INBOX (MESSAGES 1 UIDNEXT 2 UIDVALIDITY 1792083395) folders=5
factory-demo@sylway.cloud LOGIN_OK INBOX (MESSAGES 0 UIDNEXT 1 UIDVALIDITY 1792178344) folders=5
== smtp submission 587 EHLO/STARTTLS (no auth)
587 STARTTLS_OK auth=True
== runtime layout
/srv/bambook-dev/releases/1669fed6a6b4a6ed0e94cbcac0d49ddef711a8f2
v22.22.1
output
scripts
server
web
BACKEND_GUIDE.md
acceptance-tests
acceptance.vitest.config.ts
data
docker-compose.yml
docs
e2e-approval-test.mjs
edge_tts_server.py
knowledge-base-frontend
knowledge-base-scripts
knowledge_api
logs
node_modules
ops-panel
package-lock.json
package.json
prisma
scaffold-output
scripts
sensevoice_server.py
src
storage
tsconfig.json
tsconfig.mist.json
vitest.config.ts
imap-simple=5.1.0 imap=0.8.19 mailparser=3.9.1 nodemailer=7.0.12 tsx=4.21.0 ts-node=10.9.2 typescript=5.9.3 
User=bambook-deploy
WorkingDirectory=/srv/bambook-dev/current/server
EnvironmentFile=/etc/bambook-dev/backend.env
ExecStart=/usr/bin/node node_modules/tsx/dist/cli.mjs src/mist/standalone.ts
== github reachability
301
/usr/bin/git
