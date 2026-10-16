# 053131
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
probe "$T" /api/auth/mfa '{ok,enabled:.mfa.enabled}'
probe "$T" /api/admin/users '{n:(.users|length),mfaLeak:([.users[]|.metadata.mfa? // empty]|length),flag:([.users[]|has("mfaEnabled")]|all)}'
echo "login/mfa garbage -> $(curl -s -X POST -H 'Content-Type: application/json' -d '{"mfaToken":"x","code":"123456"}' "$B/api/auth/login/mfa" | jq -c '{error}')"
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
for j in $js; do curl -s "$B$j" | grep -oE '调整权限|退出所有设备|两步验证|重置两步验证|验证并登录' | sort -u; done
set -u
F=/srv/bambook-dev/shared/test-accounts.txt
B=https://bambook-dev.sylway.cloud
echo "current: $(readlink -f /srv/bambook-dev/current)"
EMAIL=$(sudo awk -F'\t' 'NR==9{print $2}' $F); PASS=$(sudo awk -F'\t' 'NR==9{print $3}' $F)
post() { curl -s -X POST "$B$1" -H 'Content-Type: application/json' ${3:+-H "Authorization: Bearer $3"} --data-binary "$2"; }
totp() { node -e '
const c=require("crypto");const s=process.argv[1].replace(/=+$/,"");const A="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";let b=0,v=0,o=[];for(const ch of s){v=(v<<5)|A.indexOf(ch);b+=5;if(b>=8){o.push((v>>>(b-8))&255);b-=8;}}
const k=Buffer.from(o);const ctr=Math.floor(Date.now()/30000)+Number(process.argv[2]||0);const m=Buffer.alloc(8);m.writeBigUInt64BE(BigInt(ctr));const h=c.createHmac("sha1",k).update(m).digest();const off=h[19]&15;
console.log(String(((h.readUInt32BE(off)&0x7fffffff)%1e6)).padStart(6,"0"));' "$1" "${2:-0}"; }
LOGIN=$(jq -n --arg e "$EMAIL" --arg p "$PASS" '{email:$e,password:$p}')
T=$(post /api/auth/login "$LOGIN" | jq -r '.token // empty'); echo "login: $([ -n "$T" ] && echo ok || echo FAIL)"
echo "mfa status: $(curl -s -H "Authorization: Bearer $T" $B/api/auth/mfa | jq -c '.mfa')"
SETUP=$(post /api/auth/mfa/setup "$(jq -n --arg p "$PASS" '{password:$p}')" "$T")
SECRET=$(echo "$SETUP" | jq -r '.secret // empty'); echo "setup: $([ -n "$SECRET" ] && echo ok || echo "$SETUP" | jq -c '{error}')"
[ -z "$SECRET" ] && exit 0
echo "enable wrong: $(post /api/auth/mfa/enable '{"code":"000000"}' "$T" | jq -c '{ok,error}')"
EN=$(post /api/auth/mfa/enable "{\"code\":\"$(totp $SECRET)\"}" "$T"); echo "enable: $(echo "$EN" | jq -c '{ok,n:(.recoveryCodes|length)}')"
RC=$(echo "$EN" | jq -r '.recoveryCodes[0] // empty')
STEP=$(post /api/auth/login "$LOGIN"); echo "login after enable: $(echo "$STEP" | jq -c '{mfaRequired,hasToken:(.token!=null)}')"
MT=$(echo "$STEP" | jq -r '.mfaToken // empty')
echo "mfa token as bearer: $(curl -s -o /dev/null -w %{http_code} -H "Authorization: Bearer $MT" $B/api/auth/me)"
R1=$(post /api/auth/login/mfa "$(jq -n --arg t "$MT" --arg c "$RC" '{mfaToken:$t,code:$c}')"); echo "recovery login: $(echo "$R1" | jq -c '{ok,left:.recoveryRemaining,hasToken:(.token!=null)}')"
echo "recovery reuse: $(post /api/auth/login/mfa "$(jq -n --arg t "$MT" --arg c "$RC" '{mfaToken:$t,code:$c}')" | jq -c '{error}')"
T2=$(echo "$R1" | jq -r '.token // empty')
echo "audit-ish me: $(curl -s -H "Authorization: Bearer $T2" $B/api/auth/me | jq -c '{id:(.user.id!=null)}')"
DIS=$(post /api/auth/mfa/disable "$(jq -n --arg p "$PASS" --arg c "$(totp $SECRET 1)" '{password:$p,code:$c}')" "$T2"); echo "disable (next window code): $(echo "$DIS" | jq -c '{ok,error}')"
if [ "$(echo "$DIS" | jq -r .ok)" != "true" ]; then sleep 31; DIS=$(post /api/auth/mfa/disable "$(jq -n --arg p "$PASS" --arg c "$(totp $SECRET)" '{password:$p,code:$c}')" "$T2"); echo "disable retry: $(echo "$DIS" | jq -c '{ok,error}')"; fi
echo "final status: $(curl -s -H "Authorization: Bearer $T2" $B/api/auth/mfa | jq -c '.mfa')"
echo "plain login again: $(post /api/auth/login "$LOGIN" | jq -c '{hasToken:(.token!=null),mfaRequired}')"
