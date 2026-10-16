request: 1c2014b930ec52950ebe2811965ea3751fdce10c
request-sha256: 73d69ae1badc03025f8b66abd77e891e653b43e6e5f589534c3f91206e246cbf
exit: not run
seconds: ?
finished: 2026-10-16T16:09:20Z
run: https://github.com/guqinwen3g-netizen/bambook-main/actions/runs/38929647001
---
capacity-baseline UTC 2026-10-16T16:09:16Z
Linux 7.0.0-30-generic
4
               total        used        free      shared  buff/cache   available
Mem:            3718        1175        1810          55        1076        2542
Swap:           2047         235        1812
Filesystem     1048576-blocks  Used Available Capacity Mounted on
/dev/vda3               39675  8732     29215      24% /
tmpfs                    1860   183      1677      10% /tmp
/dev/vda3               39675  8732     29215      24% /
some avg10=0.00 avg60=0.00 avg300=0.00 total=1448162
full avg10=0.00 avg60=0.00 avg300=0.00 total=1390348
some avg10=0.00 avg60=0.00 avg300=0.00 total=294768368
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
runtimes
v22.22.1
9.2.0
/usr/bin/systemd-run
/usr/bin/timeout
/usr/bin/python3
/usr/bin/curl
/usr/bin/tar
/usr/bin/git
cgroup controllers
cpuset cpu io memory hugetlb pids rdma misc dmem
services
Id=bambook-dev.service
ActiveState=active
MainPID=548800
MemoryCurrent=332476416

Id=bambook-dev-mist.service
ActiveState=active
MainPID=548808
MemoryCurrent=178237440
current
/srv/bambook-dev/releases/b22e79276638836222f6b30365121cbadb27f5f2
source availability
server/package.json present
server/package-lock.json present
.nvmrc present
server/src/mist/server.ts present
deployment disk use
461	/srv/bambook-dev/current/
1381	/srv/bambook-dev/releases
1	/srv/bambook-dev/shared
listening ports
State  Recv-Q Send-Q Local Address:Port  Peer Address:Port
LISTEN 0      200        127.0.0.1:5432       0.0.0.0:*   
LISTEN 0      511        127.0.0.1:8082       0.0.0.0:*   
LISTEN 0      511        127.0.0.1:8080       0.0.0.0:*   
LISTEN 0      511        127.0.0.1:8081       0.0.0.0:*   
LISTEN 0      4096         0.0.0.0:22         0.0.0.0:*   
LISTEN 0      4096       127.0.0.1:20241      0.0.0.0:*   
LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*   
LISTEN 0      4096       127.0.0.1:7890       0.0.0.0:*   
LISTEN 0      100        127.0.0.1:143        0.0.0.0:*   
LISTEN 0      100        127.0.0.1:25         0.0.0.0:*   
LISTEN 0      100        127.0.0.1:993        0.0.0.0:*   
LISTEN 0      4096      127.0.0.54:53         0.0.0.0:*   
LISTEN 0      100        127.0.0.1:587        0.0.0.0:*   
LISTEN 0      4096            [::]:22            [::]:*   
health latency
port=8081 code=200 seconds=0.004170
port=8082 code=200 seconds=0.018095
sudo/cgroup availability
sudo-ok
bash: line 15: systemd: command not found
