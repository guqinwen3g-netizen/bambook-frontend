request: 1c651d0eac86869a1df7ae9c5dbe0cb6058a0e99
request-sha256: 4d0200590654cd1ff81f17b70d1d199f4c34ad5fe08a29d44b9d8c1b8fc4c9cf
exit: 0
seconds: 33
finished: 2026-10-16T04:39:48Z
run: https://github.com/guqinwen3g-netizen/bambook-main/actions/runs/38851712191
---
current: /srv/bambook-dev/releases/bf0f773bdf1710fd83f79929967fad26e98ca962
public: 200
current: /srv/bambook-dev/releases/bf0f773bdf1710fd83f79929967fad26e98ca962
admin token: ok
/api/hr/employees -> 200 {"ok":true,"employees":0}
/api/hr/employment-events?limit=5 -> 200 {"ok":true,"events":0}
/api/hr/personnel -> 200 {"positions":0}
/api/auth/me -> 200 {"mustChange":false}
sales token: ok
/api/admin/permissions -> 403 {"ok":null,"error":"FORBIDDEN"}
logistics token A: ok
/api/auth/me -> 200 {"ok":true,"id":true}
logout-all -> 404
/api/auth/me -> 200 {"error":null}
logistics token B: ok
/api/auth/me -> 200 {"ok":true,"id":true}
退出所有设备
