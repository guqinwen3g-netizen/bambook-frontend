set -euo pipefail
python3 - <<'OBSERVE_CAPACITY'
import datetime,json,pathlib,time
for n in range(3):
 out={'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':[],'trials':[]}
 for root in pathlib.Path('/var/tmp').glob('bambook-ci-capacity-*'):
  if not root.is_dir() or root.is_symlink():continue
  for name in ['source.tar.gz','required-source.tar.gz','source.sha256','transport-probe.bin']+[p.name for p in root.glob('transport-part-*.bin')]:
   p=root/name
   if p.is_file():
    s=p.stat();out['files'].append({'path':str(p),'bytes':s.st_size,'mtime':s.st_mtime})
  for name in ['summary.json','progress.json']:
   p=root/name
   if p.is_file():out['trials'].append({'path':str(p),'data':json.loads(p.read_text())})
 print(json.dumps(out),flush=True)
 if n<2:time.sleep(4)
OBSERVE_CAPACITY
sudo -n ss -tin '( sport = :22 )' | head -20
systemctl show bambook-dev bambook-dev-mist -p Id -p ActiveState -p MainPID --no-pager
for p in 8081 8082; do curl --max-time 3 -s -o /dev/null -w "health port=$p code=%{http_code} seconds=%{time_total}\n" "http://127.0.0.1:$p/api/health"; done
