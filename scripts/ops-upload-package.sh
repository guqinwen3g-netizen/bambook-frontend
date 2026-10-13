#!/usr/bin/env bash
# 把当前仓库里的 ops-panel + 主 API 源码打包，上传到 Mac mini 的 Ops Panel
# 使用 osascript 弹窗输入 Ops Token，避免在 shell 历史中留下密码
set -euo pipefail

OPS_URL="${BAMBOOK_OPS_URL:-https://ops.jiangsupanda.com}"
ARCHIVE="/tmp/bambook-ops-upload.tar.gz"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -d server/ops-panel ]]; then
  echo "error: cannot find server/ops-panel under $REPO_ROOT" >&2
  exit 1
fi

# ---- 参数：上传是一条**必须显式点名**的路径（默认只打包，不联网、不取 token）----
# ★ 未知参数一律拒（打错字的 `--pack-onl` 绝不能兜成"直接上线"）
# ★★ 2026-09-28 事故后加的闸：原来"不带参数 = 直接部署"，而一次脚本内的算术错让 bash 跳过了
#     `--pack-only` 那段的 `exit 0` ⇒ 控制流**落进上传路径**，用钥匙串里的 token 静默上线了一次（HTTP 200、排了重启）。
#     ⇒ 规矩：**默认 = 只打包**；要上传必须显式给 `--deploy`，且给完还要 `BAMBOOK_ALLOW_DEPLOY=yes` 这道第二闸（防手滑、也防"解析失败后走到上传"）。
PACK_ONLY=1
PACK_TOOLS=0
WANT_DEPLOY=0
for arg in "$@"; do
  case "$arg" in
    --pack-only) PACK_ONLY=1 ;;
    --pack-tools) PACK_ONLY=1; PACK_TOOLS=1 ;;
    --deploy) PACK_ONLY=0; WANT_DEPLOY=1 ;;
    *) echo "error: 未知参数 $arg（可选：不带参数 / --pack-only = 只打包自校验不联网；--pack-tools = 另附现场工具包；--deploy = 真的上传部署（还需 BAMBOOK_ALLOW_DEPLOY=yes））" >&2; exit 2 ;;
  esac
done

pack_and_report() {
  echo "==> 打包源码..."
  TAR_FILES=(
    server/ops-panel
    server/scripts
    server/docs/ops-panel-runbook.md
    server/src
    server/prisma
    server/package.json
    server/tsconfig.json
  )
  [[ -f server/package-lock.json ]] && TAR_FILES+=(server/package-lock.json)
  [[ -f server/vitest.config.ts ]] && TAR_FILES+=(server/vitest.config.ts)

  tar --exclude='node_modules' --exclude='.git' --exclude='.playwright-mcp' \
    --exclude='dist' --exclude='build' --exclude='*.log' \
    -czf "$ARCHIVE" "${TAR_FILES[@]}"

  SIZE=$(stat -f%z "$ARCHIVE" 2>/dev/null || stat -c%s "$ARCHIVE")
  SIZE_MB=$(awk -v b="$SIZE" 'BEGIN{ printf "%.2f", b/1024/1024 }')
  echo "==> 包大小: ${SIZE_MB} MB · $ARCHIVE"
  echo "==> sha256: $(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)"

  # ★ 包里不许有 env（历史泄漏那一族的自查：清单里出现 .env 就是错的）
  LEAKY="$(tar -tzf "$ARCHIVE" | grep -E '(^|/)\.env' | head -5 || true)"
  if [[ -n "$LEAKY" ]]; then
    echo "error: 包里出现 env 文件，拒绝继续：$LEAKY" >&2
    rm -f "$ARCHIVE"
    exit 1
  fi
  echo "==> 自校验：包内无 .env（清单条目 $(tar -tzf "$ARCHIVE" | wc -l | tr -d ' ') 个）"

  # ★ 包身份要用**内容摘要**，不是整包 sha：本机是 bsdtar 3.5.3，不支持 `--sort=name`/`--mtime`，
  #   同一个 HEAD 连打两次整包 sha 都不一样（目录 mtime 进了头）。内容摘要＝逐文件 sha256 排序再摘要，稳定可核。
  MANIFEST="$(tar -tzf "$ARCHIVE" | grep -v '/$' | LC_ALL=C sort | while IFS= read -r f; do
      tar -xzOf "$ARCHIVE" "$f" | shasum -a 256 | cut -d' ' -f1
    done | shasum -a 256 | cut -d' ' -f1)"
  echo "==> 包内容摘要（可复量、与打包时刻无关）: ${MANIFEST}"
  echo "==> 迁移目录里有 $(ls server/prisma/migrations 2>/dev/null | grep -c '^2' || true) 条迁移"
}

# ---- 现场工具包（v3.217）：交付文档要求现场跑的那几件，一个都不在主包里 ----
# 为什么单独打一份而不是塞进主包：主包的内容过滤器是 `server/**`（B259 那两个出口至今等使用方拍），
# 擅自把仓库根的 scripts/ 塞进去＝替他把"包里该有什么"这个决定做了。⇒ 加一件**独立产物**，
# 部署现场多拷一个文件就能跑冒烟/演练，主包摘要一字不变。
TOOLS_ARCHIVE=/tmp/bambook-tools.tar.gz
# ★ 白名单，不是 `scripts/` 的快照：那底下有十几份验收件把演示口令写死在源码里（那是仓内历史，属轮换清单那一族），
#   而这份产物是要交到部署现场的 ⇒ "打包什么"必须是点名的，不能是"整目录扫进来"。
TOOLS_FILES=(
  scripts/deploy-smoke.ts
  scripts/m3-final-check.mjs
  scripts/known-defects-list.mjs
  scripts/acceptance-report-export-collision.mjs
  scripts/drill-backup-restore.mjs
  scripts/drill-migration-roundtrip.mjs
  scripts/migration-reversibility-census.mjs
  scripts/bootstrap-fresh-db.mjs
  scripts/seed-process-chain-walkthrough.mjs
  scripts/lib/drill-db.mjs
  scripts/lib/migration-sql.mjs
)
pack_tools() {
  for f in "${TOOLS_FILES[@]}"; do
    if [[ ! -f "$f" ]]; then echo "error: 工具清单里的 $f 不在仓库里 ⇒ 不许打出一份缺件的产物" >&2; exit 1; fi
  done
  tar -czf "$TOOLS_ARCHIVE" "${TOOLS_FILES[@]}"
  if tar -tzf "$TOOLS_ARCHIVE" | grep -E '(^|/)\.env' >/dev/null; then
    echo "error: 工具包里出现 env 文件，拒绝继续" >&2; rm -f "$TOOLS_ARCHIVE"; exit 1
  fi
  # ★ 凭据自查（历史泄漏那一族的延伸）：逐文件扫"口令形态字面量"，命中就拒绝出货
  LEAKED=""
  for f in $(tar -tzf "$TOOLS_ARCHIVE"); do
    # 只抓**字面量**：带 `${...}` 插值的行是"运行时拼出来的 URL/口令"，那是代码不是凭据（否则演练件会被误判）
    HITS="$(tar -xzOf "$TOOLS_ARCHIVE" "$f" 2>/dev/null | grep -nE 'Bambook@[0-9]{4}|(AKIA|sk-)[A-Za-z0-9]{8,}|postgres(ql)?://[A-Za-z0-9_.-]+:[A-Za-z0-9_.%-]{6,}@' | grep -v '\${' | head -2 || true)"
    [[ -n "$HITS" ]] && LEAKED="$LEAKED
  $f: $(echo "$HITS" | head -1 | cut -c1-90)"
  done
  if [[ -n "$LEAKED" ]]; then
    echo "error: 工具包里疑似带凭据 ⇒ 拒绝交付（把字面量改成 env 读取再重打）:$LEAKED" >&2
    rm -f "$TOOLS_ARCHIVE"; exit 1
  fi
  T_MANIFEST="$(tar -tzf "$TOOLS_ARCHIVE" | grep -v '/$' | LC_ALL=C sort | while IFS= read -r f; do
      tar -xzOf "$TOOLS_ARCHIVE" "$f" | shasum -a 256 | cut -d' ' -f1
    done | shasum -a 256 | cut -d' ' -f1)"
  echo "==> 工具包: $TOOLS_ARCHIVE · $(stat -f%z "$TOOLS_ARCHIVE" 2>/dev/null || stat -c%s "$TOOLS_ARCHIVE") 字节 · 条目 $(tar -tzf "$TOOLS_ARCHIVE" | wc -l | tr -d ' ') · 内容摘要 ${T_MANIFEST}"
  # ★ 回读**按 TOOLS_FILES 自己派生**（原来这里手抄了 8 个文件名，而清单已有 11 条 ⇒
  #   少抄的那几件（两份 lib + 本批新加的播种件）其实没被"都在"这条检查覆盖过，那句"8 件"也是个手写的词而不是数出来的）
  MISSING=0
  for f in "${TOOLS_FILES[@]}"; do
    if ! tar -tzf "$TOOLS_ARCHIVE" | grep -qx -- "$f"; then echo "   ✗ 缺 $f"; MISSING=$((MISSING+1)); fi
  done
  if [[ "$MISSING" != "0" ]]; then echo "error: 工具包少了 $MISSING 件点名的工具 ⇒ 不许交" >&2; exit 1; fi
  echo "==> 自证：${#TOOLS_FILES[@]} 件点名工具逐名回读都在 · 包内无 env · 无口令/密钥形态字面量"
}

if [[ "$PACK_ONLY" == "1" ]]; then
  pack_and_report
  if [[ "$PACK_TOOLS" == "1" ]]; then pack_tools; fi
  echo "==> 只打包模式：到此为止（没取 token、没联网、没上传）。要真的部署，必须显式给 --deploy 且带 BAMBOOK_ALLOW_DEPLOY=yes。"
  exit 0
fi

# ★ 部署的双闸：显式点名 + 环境变量再确认，缺一条都拒绝（生产部署的决定权在使用方，不在开发方）
if [[ "$WANT_DEPLOY" != "1" ]]; then
  echo "error: 没有 --deploy ⇒ 本件拒绝上传（默认行为是只打包）" >&2; exit 2
fi
if [[ "${BAMBOOK_ALLOW_DEPLOY:-}" != "yes" ]]; then
  echo "error: --deploy 还需要 BAMBOOK_ALLOW_DEPLOY=yes 才会真的上传（这道闸是 09-28 那次误上线之后加的）" >&2; exit 2
fi

# 从 keychain 里读 token；没有就弹窗输入
OPS_TOKEN="$(security find-generic-password -a bambook-ops -s bambook-ops-token -w 2>/dev/null || true)"
TOKEN_FROM_KEYCHAIN=0
if [[ -n "$OPS_TOKEN" ]]; then
  TOKEN_FROM_KEYCHAIN=1
fi

if [[ -z "$OPS_TOKEN" ]]; then
  OPS_TOKEN="$(osascript <<'OSA'
try
  set dlg to display dialog "请输入 Bambook Ops Panel 管理员 Token：" default answer "" with hidden answer with title "Bambook 部署" buttons {"取消", "确定"} default button "确定"
  if button returned of dlg is "确定" then return text returned of dlg
end try
return ""
OSA
  )"
fi

if [[ -z "$OPS_TOKEN" ]]; then
  echo "已取消（未输入 token）" >&2
  exit 1
fi

if [[ "$TOKEN_FROM_KEYCHAIN" != "1" ]]; then
  # 是否记到 keychain
  SAVE_CHOICE="$(osascript -e 'try' -e 'set r to button returned of (display dialog "是否把 token 保存到 macOS 钥匙串，下次免输入？" buttons {"不保存", "保存"} default button "保存" with title "Bambook 部署")' -e 'return r' -e 'end try' 2>/dev/null || echo "不保存")"
  if [[ "$SAVE_CHOICE" == "保存" ]]; then
    security delete-generic-password -a bambook-ops -s bambook-ops-token >/dev/null 2>&1 || true
    security add-generic-password -a bambook-ops -s bambook-ops-token -w "$OPS_TOKEN" >/dev/null
  fi
fi

pack_and_report
echo "==> 上传到 $OPS_URL/api/admin/deploy-package ..."

HTTP_RESP=$(mktemp)
HTTP_CODE=$(curl -sS --http1.1 -m 360 -o "$HTTP_RESP" -w '%{http_code}' \
  -X POST "$OPS_URL/api/admin/deploy-package" \
  -H 'Content-Type: application/gzip' \
  -H "X-Bambook-Ops-Token: $OPS_TOKEN" \
  --data-binary "@$ARCHIVE")

unset OPS_TOKEN

echo "==> HTTP $HTTP_CODE"
if command -v jq >/dev/null 2>&1; then
  jq -r '.message // .error // .' "$HTTP_RESP" 2>/dev/null || cat "$HTTP_RESP"
else
  cat "$HTTP_RESP"
fi
echo
rm -f "$HTTP_RESP"

if [[ "$HTTP_CODE" != "200" ]]; then
  osascript -e "display notification \"HTTP $HTTP_CODE, check Ops Panel logs\" with title \"Bambook deploy failed\"" 2>/dev/null || true
  exit 2
fi

osascript -e 'display notification "Ops Panel + Main API deployed. Restart scheduled." with title "Bambook deploy complete"' 2>/dev/null || true
echo "✓ 部署成功"
