request: e1a59305b1e9962fe81354010ac9b2502b5f803a
exit: 0
seconds: 44
finished: 2026-10-15T16:54:50Z
run: https://github.com/guqinwen3g-netizen/bambook-main/actions/runs/38772804780
---
mail-install-1
apt-ok
useradd warning: vmail's uid 5000 is greater than SYS_UID_MAX 999
accounts: sales@sylway.cloud finance@sylway.cloud customer-demo@sylway.cloud factory-demo@sylway.cloud
== doveconf
doveconf-ok
== postfix check
updating /etc/localtime => /var/spool/postfix//etc/localtime
updating /etc/services => /var/spool/postfix//etc/services
updating /etc/resolv.conf => /var/spool/postfix//etc/resolv.conf
updating /etc/hosts => /var/spool/postfix//etc/hosts
updating /etc/host.conf => /var/spool/postfix//etc/host.conf
updating /etc/nsswitch.conf => /var/spool/postfix//etc/nsswitch.conf
updating /usr/lib/x86_64-linux-gnu/libnss_systemd.so.2 => /var/spool/postfix//usr/lib/x86_64-linux-gnu/libnss_systemd.so.2
postfix/postlog: warning: not owned by root: /var/spool/postfix/etc/resolv.conf
postfix-ok
active
active
127.0.0.1:143
127.0.0.1:25
127.0.0.1:993
127.0.0.1:587
Oct 16 00:54:33 VM-0-17-ubuntu systemd[1]: Started dovecot.service - Dovecot IMAP/POP3 email server.
Oct 16 00:54:39 VM-0-17-ubuntu systemd[1]: Stopping dovecot.service - Dovecot IMAP/POP3 email server...
Oct 16 00:54:39 VM-0-17-ubuntu dovecot[204747]: master: Warning: Killed with signal 15 (by pid=205139 uid=0 code=kill)
Oct 16 00:54:39 VM-0-17-ubuntu systemd[1]: dovecot.service: Deactivated successfully.
Oct 16 00:54:39 VM-0-17-ubuntu systemd[1]: Stopped dovecot.service - Dovecot IMAP/POP3 email server.
Oct 16 00:54:39 VM-0-17-ubuntu systemd[1]: Starting dovecot.service - Dovecot IMAP/POP3 email server...
Oct 16 00:54:39 VM-0-17-ubuntu dovecot[205144]: master: Dovecot v2.4.2 (0962ed2104) starting up for imap, lmtp (core dumps disabled)
Oct 16 00:54:39 VM-0-17-ubuntu systemd[1]: Started dovecot.service - Dovecot IMAP/POP3 email server.
Oct 16 00:54:47 VM-0-17-ubuntu systemd[1]: Stopping dovecot.service - Dovecot IMAP/POP3 email server...
Oct 16 00:54:47 VM-0-17-ubuntu dovecot[205144]: master: Warning: Killed with signal 15 (by pid=206021 uid=0 code=kill)
Oct 16 00:54:48 VM-0-17-ubuntu systemd[1]: dovecot.service: Deactivated successfully.
Oct 16 00:54:48 VM-0-17-ubuntu systemd[1]: Stopped dovecot.service - Dovecot IMAP/POP3 email server.
Oct 16 00:54:48 VM-0-17-ubuntu systemd[1]: Starting dovecot.service - Dovecot IMAP/POP3 email server...
Oct 16 00:54:48 VM-0-17-ubuntu dovecot[206027]: master: Dovecot v2.4.2 (0962ed2104) starting up for imap, lmtp (core dumps disabled)
Oct 16 00:54:48 VM-0-17-ubuntu systemd[1]: Started dovecot.service - Dovecot IMAP/POP3 email server.
