request: 643095982618394f989c52a06a9df514c21d06a8
exit: 0
seconds: 17
finished: 2026-10-15T16:50:49Z
run: https://github.com/guqinwen3g-netizen/bambook-main/actions/runs/38772322854
---
mail-probe-2
== apt
postfix:
  Candidate: 3.10.6-4ubuntu2.2
dovecot-core:
  Candidate: 1:2.4.2+dfsg1-3ubuntu2.1
dovecot-imapd:
  Candidate: 1:2.4.2+dfsg1-3ubuntu2.1
dovecot-lmtpd:
  Candidate: 1:2.4.2+dfsg1-3ubuntu2.1
opendkim:
  Candidate: 2.11.0~beta2-9.2build1
== net
https://github.com 200
fail
https://deb.debian.org 200
https://acme-v02.api.letsencrypt.org/directory 200
== cloudflared
active
config.yml
edc46df0-8012-44c4-a4e4-ced930c6f5b9.json
== ingress
tunnel: edc46df0-8012-44c4-a4e4-ced930c6f5b9
ingress:
  - hostname: bambook-dev.sylway.cloud
    service: http://127.0.0.1:8080
  - service: http_status:404
== shared
total 64
drwxr-xr-x 10 bambook-deploy bambook-deploy 4096 Oct 15 18:53 .
drwxr-xr-x  4 bambook-deploy bambook-deploy 4096 Oct 16 00:50 ..
-rw-r--r--  1 bambook-deploy bambook-deploy  768 Oct 15 16:25 activate.log
-rw-r--r--  1 bambook-deploy bambook-deploy  917 Oct 15 16:56 activate3.log
-rw-r--r--  1 bambook-deploy bambook-deploy  677 Oct 15 17:01 activate4.log
-rw-r--r--  1 bambook-deploy bambook-deploy  677 Oct 15 17:10 activate5.log
-rw-r--r--  1 bambook-deploy bambook-deploy  690 Oct 15 18:47 activate6.log
drwx------  2 bambook-deploy bambook-deploy 4096 Oct 15 18:25 ai-subscriptions
drwxr-x---  2 bambook-deploy bambook-deploy 4096 Oct 15 16:51 data
drwxr-x---  2 bambook-deploy bambook-deploy 4096 Oct 16 00:11 logs
drwx------  4 bambook-deploy bambook-deploy 4096 Oct 15 18:57 mist-files
drwxr-x---  2 bambook-deploy bambook-deploy 4096 Oct 15 16:59 output
drwx------  3 bambook-deploy bambook-deploy 4096 Oct 15 16:55 private-files
drwxr-x---  2 bambook-deploy bambook-deploy 4096 Oct 15 16:51 storage
-rw-------  1 root           root            580 Oct 15 16:39 test-accounts.txt
drwx------  3 bambook-deploy bambook-deploy 4096 Oct 15 17:01 uploads
