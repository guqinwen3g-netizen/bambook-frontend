set -euo pipefail
python3 - <<'CAPACITY_STATUS'
import json,pathlib
p=pathlib.Path('/var/tmp/bambook-ci-capacity-evidence-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd')
for name in ['summary.json','progress.json']:
 f=p/name
 if f.exists(): print(name+'\n'+f.read_text())
f=p/'metrics.jsonl'
if f.exists():
 lines=f.read_text().splitlines()
 if lines: print('latest_metrics\n'+lines[-1])
root=pathlib.Path('/var/tmp/bambook-ci-capacity-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd')
f=root/'source.tar.gz'
if f.exists():print('partial_source_bytes='+str(f.stat().st_size))
CAPACITY_STATUS
systemctl show bambook-dev bambook-dev-mist -p Id -p ActiveState -p MainPID --no-pager
readlink -f /srv/bambook-dev/current
for p in 8081 8082; do curl --max-time 3 -s -o /dev/null -w "health port=$p code=%{http_code} seconds=%{time_total}\n" "http://127.0.0.1:$p/api/health"; done
