set -euo pipefail
sudo -n systemctl stop bambook-ci-capacity-6d3103ab02dc bambook-ci-capacity-supervisor-6d3103ab02dc || true
systemctl show bambook-ci-capacity-6d3103ab02dc bambook-ci-capacity-supervisor-6d3103ab02dc -p Id -p ActiveState -p SubState -p Result --no-pager || true
python3 - <<'PAUSE'
import pathlib,json
root=pathlib.Path('/var/tmp/bambook-ci-capacity-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd'); evidence=pathlib.Path('/var/tmp/bambook-ci-capacity-evidence-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd')
print(json.dumps({'pause_requested':True,'scratch_retained':root.is_dir(),'private_evidence_retained':evidence.is_dir(),'worker_results_exists':(evidence/'worker.json').exists(),'progress_exists':(evidence/'progress.json').exists()}))
PAUSE
systemctl show bambook-dev bambook-dev-mist -p Id -p ActiveState -p MainPID --no-pager
for p in 8081 8082; do curl --max-time 3 -s -o /dev/null -w "health port=$p code=%{http_code} seconds=%{time_total}\n" "http://127.0.0.1:$p/api/health"; done
