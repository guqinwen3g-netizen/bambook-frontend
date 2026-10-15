set -u
echo mail-install-1
export DEBIAN_FRONTEND=noninteractive
echo "postfix postfix/main_mailer_type select No configuration" | sudo debconf-set-selections
echo "postfix postfix/mailname string mail.sylway.cloud" | sudo debconf-set-selections
sudo -E apt-get update -qq >/tmp/apt.log 2>&1
sudo -E apt-get install -y -qq postfix dovecot-core dovecot-imapd dovecot-lmtpd ssl-cert >>/tmp/apt.log 2>&1 || { echo APT-FAIL; tail -30 /tmp/apt.log; exit 1; }
echo apt-ok
getent group vmail >/dev/null || sudo groupadd -r -g 5000 vmail
id vmail >/dev/null 2>&1 || sudo useradd -r -u 5000 -g vmail -d /var/mail/vhosts -s /usr/sbin/nologin vmail
sudo install -d -o vmail -g vmail -m 750 /var/mail/vhosts
# accounts (passwords generated here, kept only in a root-only file)
ACC=/srv/bambook-dev/shared/mail-accounts.txt
sudo touch $ACC; sudo chmod 600 $ACC
sudo touch /etc/dovecot/users; sudo chown root:dovecot /etc/dovecot/users; sudo chmod 640 /etc/dovecot/users
for u in sales finance customer-demo factory-demo; do
  a="$u@sylway.cloud"
  if ! sudo grep -q "^$a:" /etc/dovecot/users; then
    pw=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)
    h=$(doveadm pw -s SHA512-CRYPT -p "$pw")
    echo "$a:$h" | sudo tee -a /etc/dovecot/users >/dev/null
    echo "$a $pw" | sudo tee -a $ACC >/dev/null
  fi
done
sudo awk -F: '{print $1" OK"}' /etc/dovecot/users | sudo tee /etc/postfix/vmailbox >/dev/null
sudo awk -F: '{print $1" "$1}' /etc/dovecot/users | sudo tee /etc/postfix/sender_login >/dev/null
echo accounts: $(sudo cut -d: -f1 /etc/dovecot/users | tr '\n' ' ')
# dovecot
[ -f /etc/dovecot/dovecot.conf.orig ] || sudo cp /etc/dovecot/dovecot.conf /etc/dovecot/dovecot.conf.orig
sudo tee /etc/dovecot/dovecot.conf >/dev/null <<'EOF'
# bambook-dev mail (sylway.cloud) - managed via ops channel
dovecot_config_version = 2.4.2
dovecot_storage_version = 2.4.2
protocols = imap lmtp
listen = 127.0.0.1
log_path = syslog
auth_mechanisms = plain login
auth_allow_cleartext = no
mail_driver = maildir
mail_path = ~/Maildir
mail_uid = vmail
mail_gid = vmail
mail_home = /var/mail/vhosts/%{user | domain}/%{user | username}
passdb passwd-file {
  passwd_file_path = /etc/dovecot/users
}
userdb static {
  fields {
    uid = vmail
    gid = vmail
    home = /var/mail/vhosts/%{user | domain}/%{user | username}
  }
}
ssl = required
ssl_server_cert_file = /etc/ssl/certs/ssl-cert-snakeoil.pem
ssl_server_key_file = /etc/ssl/private/ssl-cert-snakeoil.key
namespace inbox {
  inbox = yes
  separator = /
  mailbox Drafts {
    special_use = \Drafts
    auto = subscribe
  }
  mailbox Sent {
    special_use = \Sent
    auto = subscribe
  }
  mailbox Trash {
    special_use = \Trash
    auto = subscribe
  }
  mailbox Junk {
    special_use = \Junk
    auto = subscribe
  }
}
service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0660
    user = postfix
    group = postfix
  }
}
EOF
echo '== doveconf'; sudo doveconf -n >/dev/null 2>/tmp/dc.err && echo doveconf-ok || cat /tmp/dc.err
# postfix
sudo tee /etc/postfix/main.cf >/dev/null <<'EOF'
# bambook-dev mail (sylway.cloud) - managed via ops channel
compatibility_level = 3.10
myhostname = mail.sylway.cloud
myorigin = sylway.cloud
mydestination = localhost
inet_interfaces = loopback-only
inet_protocols = ipv4
mynetworks = 127.0.0.0/8
smtpd_banner = $myhostname ESMTP
biff = no
append_dot_mydomain = no
alias_maps = hash:/etc/aliases
alias_database = hash:/etc/aliases
recipient_delimiter = +
message_size_limit = 26214400
virtual_mailbox_domains = sylway.cloud
virtual_mailbox_maps = texthash:/etc/postfix/vmailbox
virtual_transport = lmtp:unix:private/dovecot-lmtp
smtpd_sasl_type = dovecot
smtpd_sasl_path = private/auth
smtpd_sasl_auth_enable = no
smtpd_tls_cert_file = /etc/ssl/certs/ssl-cert-snakeoil.pem
smtpd_tls_key_file = /etc/ssl/private/ssl-cert-snakeoil.key
smtpd_tls_security_level = may
smtp_tls_security_level = may
smtpd_relay_restrictions = permit_mynetworks permit_sasl_authenticated reject_unauth_destination
smtpd_sender_login_maps = texthash:/etc/postfix/sender_login
# Outbound port 25 is blocked on this Tencent Cloud host; bounce immediately instead of queueing.
default_transport = error:5.7.1 external delivery is not enabled on bambook-dev yet
relay_transport = error:5.7.1 external delivery is not enabled on bambook-dev yet
EOF
grep -q '^submission inet' /etc/postfix/master.cf || sudo tee -a /etc/postfix/master.cf >/dev/null <<'EOF'
submission inet n       -       y       -       -       smtpd
  -o syslog_name=postfix/submission
  -o smtpd_tls_security_level=encrypt
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_tls_auth_only=yes
  -o smtpd_client_restrictions=permit_sasl_authenticated,reject
  -o smtpd_sender_restrictions=reject_sender_login_mismatch
  -o smtpd_relay_restrictions=permit_sasl_authenticated,reject
EOF
sudo newaliases 2>/dev/null; echo '== postfix check'; sudo postfix check && echo postfix-ok
sudo systemctl enable --now dovecot postfix >/dev/null 2>&1
sudo systemctl restart dovecot postfix
sleep 2
systemctl is-active dovecot postfix
ss -ltn | awk '{print $4}' | grep -E ':(25|587|143|993)$'
sudo journalctl -u dovecot -n 15 --no-pager | cut -c1-200
