set -euo pipefail
printf 'capacity launch diagnostic\n'
sudo -n journalctl -u bambook-ci-capacity-supervisor-6d3103ab02dc -u bambook-ci-capacity-6d3103ab02dc -n 35 --no-pager -o cat | tail -30
printf 'supported runtime and limits\n'; systemctl --version | head -1; free -m; df -Pm /var/tmp
printf 'exact prepared source marker\n'; cat /var/tmp/bambook-ci-capacity-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd/source.sha256
printf 'current release\n'; readlink -f /srv/bambook-dev/current
systemctl show bambook-dev bambook-dev-mist -p Id -p ActiveState -p MainPID --no-pager
