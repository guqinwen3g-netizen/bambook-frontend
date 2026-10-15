set -u
echo '== current'; readlink -f /srv/bambook-dev/current
ls -1dt /srv/bambook-dev/releases/*/ | head
echo '== services'; systemctl is-active bambook-dev bambook-dev-mist
curl -s -o /dev/null -w 'health %{http_code}\n' --max-time 5 http://127.0.0.1:8081/api/health
echo '== processes'; ps -eo pid,etime,user,args | grep -E 'prisma|npm|tsc|receiver' | grep -v grep | cut -c1-200
echo '== node'; node --version; npm --version
echo '== prisma cache'; sudo ls -la /home/bambook-deploy/.cache/prisma 2>&1 | head; sudo find /home/bambook-deploy/.cache/prisma -maxdepth 4 2>/dev/null | head -20
echo '== engines in releases'; for r in /srv/bambook-dev/releases/*/; do echo $r; ls $r/server/node_modules/@prisma/engines 2>/dev/null | head -5; ls $r/server/node_modules/.prisma/client 2>/dev/null | grep -i node | head; done
echo '== prisma version'; grep '"prisma"\|@prisma/client' /srv/bambook-dev/releases/349db8d155b8e06c4b842ceec12aa4f0fe4dfa22/server/package.json 2>/dev/null
echo '== env proxies'; sudo grep -ih 'PRISMA\|proxy\|registry' /etc/bambook-dev/*.env /home/bambook-deploy/.npmrc /etc/npmrc 2>/dev/null | sed 's/=.*/=<set>/'
echo '== reach'; for u in https://binaries.prisma.sh https://registry.npmjs.org https://registry.npmmirror.com; do curl -s -o /dev/null -w "$u %{http_code} %{time_total}s\n" --max-time 15 $u; done
echo '== receiver log'; sudo journalctl -t bambook-dev-receiver -n 30 --no-pager 2>/dev/null | tail -30
