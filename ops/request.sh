set -u
echo mail-probe-1
echo '== os'; . /etc/os-release; echo "$PRETTY_NAME"; uname -r; nproc; free -m | head -2; df -h / | tail -1
echo '== ip'; curl -s --max-time 5 https://api.ipify.org; echo; curl -s --max-time 3 http://metadata.tencentyun.com/latest/meta-data/public-ipv4; echo
echo '== listen'; ss -ltnp 2>/dev/null | awk '{print $4, $6}' | cut -c1-120
echo '== tools'; for c in docker podman nginx caddy postfix dovecot certbot; do printf '%s: ' $c; command -v $c || echo no; done
echo '== outbound 25'; for h in gmail-smtp-in.l.google.com mx1.qq.com; do timeout 8 bash -c "echo > /dev/tcp/$h/25" && echo "$h:25 open" || echo "$h:25 blocked"; done
echo '== outbound 587'; timeout 8 bash -c 'echo > /dev/tcp/smtp.gmail.com/587' && echo open || echo blocked
echo '== firewall'; (ufw status 2>/dev/null || true) | head -5; (firewall-cmd --list-all 2>/dev/null || true) | head -8; iptables -S INPUT 2>/dev/null | head -8
echo '== whoami'; id; sudo -n true 2>/dev/null && echo sudo-ok || echo no-sudo
