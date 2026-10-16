# 044635
echo "current: $(readlink -f /srv/bambook-dev/current)"
echo "public: $(curl -s -o /dev/null -w %{http_code} https://bambook-dev.sylway.cloud/)"
set -u
F=/srv/bambook-dev/shared/test-accounts.txt
B=https://bambook-dev.sylway.cloud
echo "current: $(readlink -f /srv/bambook-dev/current)"
login() {
  local email pass
  email=$(sudo awk -F'\t' -v n="$1" 'NR==n{print $2}' $F); pass=$(sudo awk -F'\t' -v n="$1" 'NR==n{print $3}' $F)
  jq -n --arg e "$email" --arg p "$pass" '{email:$e,password:$p}' | curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' --data-binary @- | jq -r '.token // .accessToken // empty'
}
probe() {
  local out code; out=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $1" "$B$2"); code=$(echo "$out" | tail -1)
  echo "$2 -> $code $(echo "$out" | sed '$d' | jq -c "$3" 2>/dev/null | head -c 300)"
}
T=$(login 3); echo "admin token: $([ -n "$T" ] && echo ok || echo missing)"
probe "$T" /api/hr/employees '{ok,employees:(.employees|length)}'
probe "$T" "/api/hr/employment-events?limit=5" '{ok,events:(.events|length)}'
probe "$T" /api/hr/personnel '{positions:(.positions|length)}'
probe "$T" /api/auth/me '{mustChange:(.user.mustChangePassword // false)}'
S=$(login 6); echo "sales token: $([ -n "$S" ] && echo ok || echo missing)"
probe "$S" /api/admin/permissions '{ok,error}'
L=$(login 9); echo "logistics token A: $([ -n "$L" ] && echo ok || echo missing)"
probe "$L" /api/auth/me '{ok,id:(.user.id!=null)}'
sleep 1
echo "logout-all -> $(curl -s -o /dev/null -w %{http_code} -X POST -H "Authorization: Bearer $L" -H 'Content-Type: application/json' -d '{}' "$B/api/auth/logout-all")"
probe "$L" /api/auth/me '{error}'
sleep 1
L2=$(login 9); echo "logistics token B: $([ -n "$L2" ] && echo ok || echo missing)"
probe "$L2" /api/auth/me '{ok,id:(.user.id!=null)}'
html=$(curl -s "$B/"); js=$(echo "$html" | grep -oE 'src="[^"]+\.js"' | head -3 | sed -E 's/src="([^"]+)"/\1/')
for j in $js; do curl -s "$B$j" | grep -oE '订单毛利|办理在职变动|请先修改登录密码|退出所有设备|调整权限' | sort -u; done
