request: 5e1c388ee46a36001f07f35edc38bdc5edb5d683
request-sha256: cae3fff357ec86a8c0d20a259244d88429fd6c1039a44bef197f20f511b8f09d
exit: 0
seconds: 23
finished: 2026-10-16T03:28:21Z
run: https://github.com/guqinwen3g-netizen/bambook-main/actions/runs/38845638282
---
admin token: ok
/api/admin/users -> 200 {"users":29,"pending":0,"departments":7}
/api/admin/roles -> 200 {"roles":18,"names":["业务员","销售主管","财务","领导","QC","后勤","总经理","logistics","production_manager","factory","Owner","Admin","Manager","Merchandiser","Finance","Sales","Viewer","Agent Operator"]}
/api/admin/audit-logs?limit=3 -> 200 {"total":51,"actions":["login","login","login"]}
/api/hr/personnel -> 200 {"people":18,"departments":[{"name":"业务部","parentId":true,"attrs":[]},{"name":"后勤部","parentId":true,"attrs":[]},{"name":"总公司","parentId":false,"attrs":[]},{"name":"总经办","parentId":true,"attrs":[]},{"name":"行政人事部","parentId":true,"attrs":[]},{"name":"财务部","pare
/api/hr/teams -> 200 {"teams":[{"name":"成衣三组","department":"业务部","memberCount":5},{"name":"成衣二组","department":"业务部","memberCount":5},{"name":"成衣一组","department":"业务部","memberCount":5},{"name":"面料二组","department":"业务部","memberCount":4},{"name":"面料一组","depart
sales token: ok
/api/admin/users -> 403 {"ok":null,"error":"FORBIDDEN"}
/api/hr/personnel -> 403 {"ok":null,"error":"FORBIDDEN","people":0}
js: /assets/index-DCjuEUpW.js
打开搜索结果页查看全部
本地工作区没有公司组织架构
注册申请待审批
