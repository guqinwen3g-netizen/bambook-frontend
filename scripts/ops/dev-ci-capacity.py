#!/usr/bin/env python3
"""One bounded, isolated developer-host capacity trial; never installs a runner."""
import json, os, pathlib, shutil, subprocess, sys, time
SHA = sys.argv[2]
assert len(SHA) == 40 and all(c in '0123456789abcdef' for c in SHA)
ROOT = pathlib.Path('/var/lib/bambook-ci-capacity-' + SHA)
EVIDENCE = pathlib.Path('/var/lib/bambook-ci-capacity-evidence-' + SHA)
UNIT = 'bambook-ci-capacity-' + SHA[:12]

def save(name, value):
    tmp = EVIDENCE / (name + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    tmp.replace(EVIDENCE / name)

def worker():
    env = dict(os.environ)
    env.update(HOME=str(ROOT/'home'), TMPDIR=str(ROOT/'tmp'), npm_config_cache=str(ROOT/'npm-cache'),
               NODE_OPTIONS='--max-old-space-size=1024', UV_THREADPOOL_SIZE='2', RAYON_NUM_THREADS='2',
               CI='true', DATABASE_URL='postgresql://capacity:capacity@127.0.0.1:1/capacity_isolated')
    # Use the same ordered coverage as verify:mist. Continue after a test assertion failure
    # only to measure every remaining stage once; any failed stage fails the whole trial.
    phases = [
        ('install-frontend', ['npm','ci','--no-audit','--no-fund'], 240),
        ('install-server', ['npm','ci','--prefix','server','--no-audit','--no-fund'], 240),
        ('prisma-generate', ['npm','--prefix','server','exec','--','prisma','generate','--schema=server/prisma/schema.prisma'], 90),
        ('typecheck-frontend', ['npm','run','typecheck:mist'], 180),
        ('typecheck-server', ['npm','run','typecheck:mist:server'], 180),
        ('test-frontend', ['npm','test','--','--maxWorkers=1','--no-file-parallelism'], 240),
        ('test-mist-server', ['npm','run','test:mist:server'], 180),
        ('test-access', ['npm','run','test:access:server'], 180),
        ('test-tooling', ['npm','run','test:mist:tooling'], 90),
        ('build', ['npm','run','build'], 180),
        ('mist-check', ['npm','run','mist:check'], 90),
    ]
    results=[]
    for name, command, timeout in phases:
        save('progress.json', {'phase':name,'results':results,'sha':SHA})
        start=time.monotonic()
        with (EVIDENCE/(name+'.log')).open('w') as out:
            try:
                result=subprocess.run(['/usr/bin/timeout','--signal=TERM','--kill-after=10',str(timeout)]+command,
                    cwd=ROOT/'source',env=env,stdout=out,stderr=subprocess.STDOUT)
                code=result.returncode
            except Exception as e:
                out.write(type(e).__name__+': '+str(e)); code=125
        results.append({'phase':name,'command':command,'seconds':round(time.monotonic()-start,2),'exit':code})
        save('progress.json', {'phase':name,'results':results,'sha':SHA})
        if code and name in ('install-frontend','install-server','prisma-generate'):
            break
    complete=len(results)==len(phases)
    save('worker.json',{'sha':SHA,'coverage_complete':complete,'success':complete and all(x['exit']==0 for x in results),'results':results})
    return 0 if complete and all(x['exit']==0 for x in results) else 1

def mem():
    return {k:int(v.split()[0])*1024 for k,v in (line.split(':',1) for line in pathlib.Path('/proc/meminfo').read_text().splitlines())}

def health():
    rows=[]
    for port in (8081,8082):
        start=time.monotonic()
        r=subprocess.run(['curl','--max-time','2','-s','-o','/dev/null','-w','%{http_code}',f'http://127.0.0.1:{port}/api/health'],capture_output=True,text=True)
        rows.append({'port':port,'code':r.stdout.strip(),'seconds':round(time.monotonic()-start,4),'exit':r.returncode})
    return rows

def supervisor():
    start=time.monotonic(); initial=mem(); baseline=health()
    if initial['MemAvailable'] < 2300*1024**2 or shutil.disk_usage(ROOT).free < 12*1024**3 or any(x['code']!='200' for x in baseline):
        save('summary.json',{'sha':SHA,'started':False,'reason':'baseline threshold or health not satisfied','available':initial['MemAvailable'],'health':baseline})
        return 2
    uid=str(os.getuid()); gid=str(os.getgid())
    args=['sudo','-n','systemd-run','--quiet','--unit='+UNIT,'--uid='+uid,'--gid='+gid,
        '-p','Type=exec','-p','RemainAfterExit=yes','-p','RuntimeMaxSec=780','-p','MemoryMax=2048M',
        '-p','MemoryHigh=1792M','-p','MemorySwapMax=256M','-p','CPUQuota=200%',
        '-p','CPUWeight=20','-p','IOWeight=20','-p','TasksMax=160','-p','OOMPolicy=stop',
        '-p','Nice=10','-p','PrivateTmp=yes','-p','ProtectHome=yes','-p','ProtectSystem=strict',
        '-p','ReadWritePaths='+str(ROOT)+' '+str(EVIDENCE),'-p','InaccessiblePaths=/srv/bambook-dev /run/postgresql /var/lib/postgresql',
        '-p','NoNewPrivileges=yes','-p','RestrictSUIDSGID=yes',
        '/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','LANG=C.UTF-8',
        '/usr/bin/python3',str(ROOT/'trial.py'),'worker',SHA]
    subprocess.run(args,check=True)
    peak=0; min_available=initial['MemAvailable']; max_swap=0; max_growth=0; bad=0; reason=None; last_health=baseline; last_du=0
    initial_used=shutil.disk_usage(ROOT).used
    with (EVIDENCE/'metrics.jsonl').open('w') as metrics:
        while True:
            elapsed=time.monotonic()-start; m=mem()
            min_available=min(min_available,m['MemAvailable'])
            swap_used=m['SwapTotal']-m['SwapFree']; max_swap=max(max_swap,swap_used-(initial['SwapTotal']-initial['SwapFree']))
            cg=pathlib.Path('/sys/fs/cgroup/system.slice')/(UNIT+'.service')
            try: peak=max(peak,int((cg/'memory.peak').read_text()))
            except OSError: pass
            disk=shutil.disk_usage(ROOT); max_growth=max(max_growth,disk.used-initial_used)
            if int(elapsed)//10 != last_du:
                last_du=int(elapsed)//10; last_health=health()
                states=subprocess.run(['systemctl','is-active','bambook-dev','bambook-dev-mist'],capture_output=True,text=True).stdout.splitlines()
                unhealthy=any(x['code']!='200' or x['seconds']>1 for x in last_health) or states!=['active','active']
                bad=bad+1 if unhealthy else 0
            metrics.write(json.dumps({'elapsed':round(elapsed,2),'available':m['MemAvailable'],'swap_used':swap_used,'memory_peak':peak,'disk_growth':disk.used-initial_used,'load':os.getloadavg(),'health':last_health})+'\n');metrics.flush()
            if m['MemAvailable'] < 650*1024**2: reason='available memory below 650 MiB'
            elif max_swap > 256*1024**2: reason='system swap growth above 256 MiB'
            elif disk.free < 10*1024**3 or max_growth>7*1024**3: reason='disk headroom boundary'
            elif bad>=2: reason='existing service health/latency degraded on two probes'
            elif elapsed>800: reason='trial total timeout'
            if reason:
                subprocess.run(['sudo','-n','systemctl','stop',UNIT],check=False)
                break
            if (EVIDENCE/'worker.json').exists(): break
            active=subprocess.run(['systemctl','show',UNIT,'-p','SubState','--value'],capture_output=True,text=True).stdout.strip()
            if active in ('failed','dead','exited') and elapsed>5:
                reason='worker stopped before writing final results: '+active; break
            time.sleep(2)
    worker_result=json.loads((EVIDENCE/'worker.json').read_text()) if (EVIDENCE/'worker.json').exists() else None
    unit_status=subprocess.run(['systemctl','show',UNIT,'-p','Result','-p','ExecMainStatus','-p','CPUUsageNSec','-p','MemoryPeak'],capture_output=True,text=True).stdout
    subprocess.run(['sudo','-n','systemctl','stop',UNIT],check=False)
    final_health=health()
    summary={'sha':SHA,'started':True,'seconds':round(time.monotonic()-start,2),'stop_reason':reason,
        'archive_sha256':(ROOT/'source.sha256').read_text().strip(),'baseline_available':initial['MemAvailable'],'minimum_available':min_available,'memory_peak':peak,'swap_growth':max_swap,
        'disk_growth':max_growth,'baseline_health':baseline,'final_health':final_health,'unit_status':unit_status,'worker':worker_result,
        'evidence':str(EVIDENCE),'cleanup':'pending'}
    save('summary.json',summary)
    # Only this exact throwaway source/home/cache and scratch directory are removed.
    if ROOT.parent==pathlib.Path('/var/lib') and not ROOT.is_symlink():
        shutil.rmtree(ROOT)
        summary['cleanup']='removed temporary source, npm cache, home, build outputs and scripts; private evidence retained'
        save('summary.json',summary)
    return 0

if __name__=='__main__':
    try:
        sys.exit(worker() if sys.argv[1]=='worker' else supervisor())
    except Exception as error:
        if sys.argv[1]!='worker':
            subprocess.run(['sudo','-n','systemctl','stop',UNIT],check=False)
            save('summary.json',{'sha':SHA,'exception':type(error).__name__+': '+str(error),'health':health(),'cleanup':'trial stopped; inspect scratch directory before removing'})
        raise
