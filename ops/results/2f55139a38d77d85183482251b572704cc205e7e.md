request: 2f55139a38d77d85183482251b572704cc205e7e
request-sha256: d63ad8cdb04b067d5110fcbec351a74c38eb6a321cde95a5d6d2332de8c86e4c
exit: 0
seconds: 4
finished: 2026-10-16T16:40:16Z
run: https://github.com/guqinwen3g-netizen/bambook-main/actions/runs/38933744775
---
capacity launch diagnostic
Started bambook-ci-capacity-supervisor-6d3103ab02dc.service - [systemd-run] /usr/bin/python3 /var/tmp/bambook-ci-capacity-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd/trial.py supervisor 6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd.
pam_unix(sudo:session): session opened for user root(uid=0) by (uid=1003)
bambook-ops :  PWD=/ ; USER=root ; COMMAND=/usr/bin/systemd-run --quiet --unit=bambook-ci-capacity-6d3103ab02dc --uid=1003 --gid=1003 -p Type=exec -p RemainAfterExit=yes -p RuntimeMaxSec=900 -p MemoryMax=2048M -p MemoryHigh=1792M -p MemorySwapMax=256M -p CPUQuota=200% -p CPUWeight=20 -p IOWeight=20 -p TasksMax=160 -p OOMPolicy=stop -p Nice=10 -p PrivateTmp=yes -p ProtectHome=yes -p ProtectSystem=strict -p ReadWritePaths=/var/tmp/bambook-ci-capacity-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd /var/tmp/bambook-ci-capacity-evidence-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd -p InaccessiblePaths=/srv/bambook-dev /run/postgresql /var/lib/postgresql -p NoNewPrivileges=yes -p RestrictSUIDSGID=yes /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 /var/tmp/bambook-ci-capacity-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd/trial.py worker 6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd
Starting bambook-ci-capacity-6d3103ab02dc.service - [systemd-run] /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 /var/tmp/bambook-ci-capacity-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd/trial.py worker 6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd...
bambook-ci-capacity-6d3103ab02dc.service: Failed to set up mount namespacing: /var/tmp/bambook-ci-capacity-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd: No such file or directory
bambook-ci-capacity-6d3103ab02dc.service: Failed at step NAMESPACE spawning /usr/bin/env: No such file or directory
bambook-ci-capacity-6d3103ab02dc.service: Main process exited, code=exited, status=226/NAMESPACE
bambook-ci-capacity-6d3103ab02dc.service: Failed with result 'exit-code'.
Failed to start bambook-ci-capacity-6d3103ab02dc.service - [systemd-run] /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 /var/tmp/bambook-ci-capacity-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd/trial.py worker 6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd.
pam_unix(sudo:session): session closed for user root
pam_unix(sudo:session): session opened for user root(uid=0) by (uid=1003)
bambook-ops :  PWD=/ ; USER=root ; COMMAND=/usr/bin/systemctl stop bambook-ci-capacity-6d3103ab02dc
pam_unix(sudo:session): session closed for user root
Traceback (most recent call last):
  File "/var/tmp/bambook-ci-capacity-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd/trial.py", line 129, in <module>
    sys.exit(worker() if sys.argv[1]=='worker' else supervisor())
                                                    ~~~~~~~~~~^^
  File "/var/tmp/bambook-ci-capacity-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd/trial.py", line 80, in supervisor
    subprocess.run(args,check=True)
    ~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^
  File "/usr/lib/python3.14/subprocess.py", line 578, in run
    raise CalledProcessError(retcode, process.args,
                             output=stdout, stderr=stderr)
subprocess.CalledProcessError: Command '['sudo', '-n', 'systemd-run', '--quiet', '--unit=bambook-ci-capacity-6d3103ab02dc', '--uid=1003', '--gid=1003', '-p', 'Type=exec', '-p', 'RemainAfterExit=yes', '-p', 'RuntimeMaxSec=900', '-p', 'MemoryMax=2048M', '-p', 'MemoryHigh=1792M', '-p', 'MemorySwapMax=256M', '-p', 'CPUQuota=200%', '-p', 'CPUWeight=20', '-p', 'IOWeight=20', '-p', 'TasksMax=160', '-p', 'OOMPolicy=stop', '-p', 'Nice=10', '-p', 'PrivateTmp=yes', '-p', 'ProtectHome=yes', '-p', 'ProtectSystem=strict', '-p', 'ReadWritePaths=/var/tmp/bambook-ci-capacity-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd /var/tmp/bambook-ci-capacity-evidence-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd', '-p', 'InaccessiblePaths=/srv/bambook-dev /run/postgresql /var/lib/postgresql', '-p', 'NoNewPrivileges=yes', '-p', 'RestrictSUIDSGID=yes', '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8', '/usr/bin/python3', '/var/tmp/bambook-ci-capacity-6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd/trial.py', 'worker', '6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd']' returned non-zero exit status 1.
bambook-ci-capacity-supervisor-6d3103ab02dc.service: Main process exited, code=exited, status=1/FAILURE
bambook-ci-capacity-supervisor-6d3103ab02dc.service: Failed with result 'exit-code'.
supported runtime and limits
systemd 259 (259.5-0ubuntu3)
               total        used        free      shared  buff/cache   available
Mem:            3718        1144        1729          54        1187        2573
Swap:           2047         243        1804
Filesystem     1048576-blocks  Used Available Capacity Mounted on
/dev/vda3               39675  8802     29145      24% /
exact prepared source marker
4f87590ec35c943853a463f506e5340b67f08586b8b1fb86976ae0766c8e455e
current release
/srv/bambook-dev/releases/6d3103ab02dc37181e2bae1dd22dda6cf5ca46cd
Id=bambook-dev.service
ActiveState=active
MainPID=560986

Id=bambook-dev-mist.service
ActiveState=active
MainPID=560998
