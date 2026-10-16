set -u
F=/srv/bambook-dev/shared/test-accounts.txt
B=https://bambook-dev.sylway.cloud
login() { # $1 line no; prints token to stdout only
  local email pass
  email=$(sudo awk -F'\t' -v n="$1" 'NR==n{print $2}' $F); pass=$(sudo awk -F'\t' -v n="$1" 'NR==n{print $3}' $F)
  jq -n --arg e "$email" --arg p "$pass" '{email:$e,password:$p}' | curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' --data-binary @- | jq -r '.token // .accessToken // empty'
}
probe() { # $1 token $2 path $3 jq summary
  local out code; out=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $1" "$B$2"); code=$(echo "$out" | tail -1)
  echo "$2 -> $code $(echo "$out" | sed '$d' | jq -c "$3" 2>/dev/null | head -c 300)"
}
T=$(login 3); echo "admin token: $([ -n "$T" ] && echo ok || echo missing)"
probe "$T" /api/admin/users '{users:(.users|length),pending:([.users[]|select(.status=="pending")]|length),departments:(.departments|length)}'
probe "$T" /api/admin/roles '{roles:(.roles|length),names:[.roles[].name]}'
probe "$T" "/api/admin/audit-logs?limit=3" '{total, actions:[.logs[].action]}'
probe "$T" /api/hr/personnel '{people:(.personnel|length),departments:[.departments[]|{name,parentId:(.parentId!=null),attrs:.businessAttributes}],positions:(.positions|length)}'
probe "$T" /api/hr/teams '{teams:[.teams[]|{name,department,memberCount}]}'
S=$(login 6); echo "sales token: $([ -n "$S" ] && echo ok || echo missing)"
probe "$S" /api/admin/users '{ok,error}'
probe "$S" /api/hr/personnel '{ok,error,people:(.personnel|length)}'
html=$(curl -s "$B/"); js=$(echo "$html" | grep -oE 'src="[^"]+\.js"' | head -3 | sed -E 's/src="([^"]+)"/\1/'); echo "js: $js"
for j in $js; do curl -s "$B$j" | grep -oE '注册申请待审批|本地工作区没有公司组织架构|打开搜索结果页查看全部' | sort -u; done
