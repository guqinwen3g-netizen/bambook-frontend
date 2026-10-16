request: 06064ede099e73f53e9d3bf0023bdb017c946f0c
request-sha256: c62be37fe14cdc1292ebdfe0dc08c8ab2fae11387f45ded14ca22a79c99b1ec9
exit: 0
seconds: 38
finished: 2026-10-16T05:08:38Z
run: https://github.com/guqinwen3g-netizen/bambook-main/actions/runs/38854171977
---
current: /srv/bambook-dev/releases/206e83c05d3f561d1d1a1648ba859a25862e4f0b
public: 200
current: /srv/bambook-dev/releases/206e83c05d3f561d1d1a1648ba859a25862e4f0b
admin token: ok
/api/hr/employees -> 200 {"ok":true,"employees":0}
/api/hr/employment-events?limit=5 -> 200 {"ok":true,"events":0}
/api/hr/personnel -> 200 {"positions":0}
/api/auth/me -> 200 {"mustChange":false}
/api/auth/mfa -> 404 
/api/admin/users -> 200 {"n":29,"mfaLeak":0,"flag":false}
jq: parse error: Invalid numeric literal at line 1, column 10
login/mfa garbage -> 
sales token: ok
/api/admin/permissions -> 403 {"ok":null,"error":"FORBIDDEN"}
logistics token A: ok
/api/auth/me -> 200 {"ok":true,"id":true}
logout-all -> 200
/api/auth/me -> 401 {"error":"SESSION_REVOKED"}
logistics token B: ok
/api/auth/me -> 200 {"ok":true,"id":true}
两步验证
调整权限
退出所有设备
