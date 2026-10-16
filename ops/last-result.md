request: 228d6155d841eac7d4d9aff906ae4458ab22fe83
request-sha256: 7de9a00aae175abba3b5499ea8a0809cf56b114107b58228c9e876764e3e4f3d
exit: 0
seconds: 54
finished: 2026-10-16T05:32:59Z
run: https://github.com/guqinwen3g-netizen/bambook-main/actions/runs/38856266624
---
current: /srv/bambook-dev/releases/cd19b0a6c810df9eea83ce4f0f4f1500d616e5d3
admin token: ok
/api/hr/employees -> 200 {"ok":true,"employees":0}
/api/hr/employment-events?limit=5 -> 200 {"ok":true,"events":0}
/api/hr/personnel -> 200 {"positions":0}
/api/auth/me -> 200 {"mustChange":false}
/api/auth/mfa -> 200 {"ok":true,"enabled":false}
/api/admin/users -> 200 {"n":29,"mfaLeak":0,"flag":true}
login/mfa garbage -> {"error":"MFA_EXPIRED"}
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
重置两步验证
验证并登录
current: /srv/bambook-dev/releases/cd19b0a6c810df9eea83ce4f0f4f1500d616e5d3
login: ok
mfa status: {"enabled":false,"enabledAt":null,"recoveryRemaining":0}
setup: ok
enable wrong: {"ok":false,"error":"MFA_INVALID"}
enable: {"ok":true,"n":10}
login after enable: {"mfaRequired":true,"hasToken":false}
mfa token as bearer: 401
recovery login: {"ok":true,"left":9,"hasToken":true}
recovery reuse: {"error":"MFA_INVALID"}
audit-ish me: {"id":true}
disable (next window code): {"ok":true,"error":null}
final status: {"enabled":false,"enabledAt":null,"recoveryRemaining":0}
plain login again: {"hasToken":true,"mfaRequired":null}
