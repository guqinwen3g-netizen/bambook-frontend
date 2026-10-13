#!/usr/bin/env bash
# 本地构建 Bambook 网页端，把 dist/ 打成 tar.gz 上传到 Mac mini 的 Ops Panel。
# Mac mini 收到后解压到 ~/bambook-main-api/webapp/，
# 主 API serve 在 https://jiangsupanda.com/bambook/api/app/ （复用 /bambook/api ingress）。
#
# 无需额外 Cloudflare Tunnel ingress 规则：/bambook/api/app/* 走已有的 /bambook/api → 8081 规则，
# 主 API 中间件 strip /bambook 前缀后，/api/app/* 由 webapp 静态中间件 serve。
#
# Token 处理与 ops-upload-package.sh 一致：先从 keychain 读，没有就弹窗。
set -euo pipefail

OPS_URL="${BAMBOOK_OPS_URL:-https://ops.jiangsupanda.com}"
ARCHIVE="/tmp/bambook-webapp-upload.tar.gz"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ★ 2026-09-29 新增（与 ops-upload-package.sh 同一道闸，**放在最前面以便坏参数立刻失败**）：
#   默认**只打包**；要真上传必须显式 `--deploy` **且** `BAMBOOK_ALLOW_DEPLOY=yes`。
#   为什么加：本脚本原来**默认就上传**，而 `Bambook-一键全量部署.command` / `Bambook-部署网页版.command`
#   都是无参调用它 ⇒ 与已硬化的后端脚本合起来会变成「后端只打包 + 前端真上传」= **半个部署**。
PACK_ONLY=1
for arg in "$@"; do
  case "$arg" in
    --pack-only) PACK_ONLY=1 ;;
    --deploy)    PACK_ONLY=0 ;;
    *) echo "error: 未知参数 $arg（可选：不带参数 / --pack-only = 只构建打包不联网；--deploy = 真的上传部署（还需 BAMBOOK_ALLOW_DEPLOY=yes））" >&2; exit 2 ;;
  esac
done

if [[ ! -f package.json ]]; then
  echo "error: cannot find package.json under $REPO_ROOT" >&2
  exit 1
fi

# 1) 构建：
#    - 默认（BAMBOOK_WEB_DEPLOY=1）让 vite.config.ts 把 base 切到 /bambook/api/app/
#    - 子域名模式（BAMBOOK_WEB_SUBDOMAIN=1）：base=/ 根路径直挂，部署到 webapp-root/，
#      入口 https://bambook.jiangsupanda.com/（需 Cloudflare Tunnel 加 Public Hostname）
#    - VITE_API_BASE_URL 写死 API 根路径，避免网页端误连非数据中心 API
#      (网页端跟主 API 同域，用相对路径即可)
if [[ "${BAMBOOK_WEB_SUBDOMAIN:-0}" == "1" ]]; then
  echo "==> 构建 webapp (BAMBOOK_WEB_SUBDOMAIN=1, base=/, API → /api, 部署目标 webapp-root)..."
  BAMBOOK_WEB_SUBDOMAIN=1 VITE_API_BASE_URL=/api npm run build
  DEPLOY_TARGET="webapp-root"
  DEPLOY_TARGET_HEADER="X-Deploy-Target: webapp-root"
else
  echo "==> 构建 webapp (BAMBOOK_WEB_DEPLOY=1, base=/bambook/api/app/, API → /bambook/api)..."
  BAMBOOK_WEB_DEPLOY=1 VITE_API_BASE_URL=/bambook/api npm run build
  DEPLOY_TARGET="webapp"
  DEPLOY_TARGET_HEADER=""
fi

if [[ ! -d dist ]]; then
  echo "error: build did not produce dist/" >&2
  exit 1
fi

if [[ -d dist/wallpapers && -x /usr/bin/sips ]]; then
  BEFORE_WALLPAPERS_KB=$(du -sk dist/wallpapers | awk '{print $1}')
  echo "==> 压缩发布包壁纸（仅 dist/wallpapers，源素材不变）..."
  # 壁纸格式归一：照片类内容统一 JPG（PNG 无损体积过大，曾致上传包超 Cloudflare 100MB 限制）
  while IFS= read -r -d '' image; do
    lower_image="$(printf '%s' "$image" | tr '[:upper:]' '[:lower:]')"
    case "$lower_image" in
      *.jpg|*.jpeg)
        /usr/bin/sips -Z 1920 -s formatOptions 70 "$image" >/dev/null || true
        ;;
      *.png)
        # PNG 壁纸转 JPG（体积降一个数量级）；原地替换并删原 PNG
        base_no_ext="${image%.*}"
        if /usr/bin/sips -s format jpeg -s formatOptions 85 -Z 1920 "$image" --out "${base_no_ext}.jpg" >/dev/null 2>&1; then
          rm -f "$image"
        else
          /usr/bin/sips -Z 1920 "$image" >/dev/null || true
        fi
        ;;
    esac
  done < <(find dist/wallpapers -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) -print0)
  AFTER_WALLPAPERS_KB=$(du -sk dist/wallpapers | awk '{print $1}')
  echo "==> 壁纸发布体积: $(awk -v kb="$BEFORE_WALLPAPERS_KB" 'BEGIN{printf "%.2f", kb/1024}') MB → $(awk -v kb="$AFTER_WALLPAPERS_KB" 'BEGIN{printf "%.2f", kb/1024}') MB"
fi

# 2) 取 token（与 ops-upload-package.sh 共用 keychain 条目）——提前到打包前：增量 diff 需要先查远端清单
OPS_TOKEN="$(security find-generic-password -a bambook-ops -s bambook-ops-token -w 2>/dev/null || true)"
if [[ -z "$OPS_TOKEN" ]]; then
  OPS_TOKEN="$(osascript <<'OSA'
try
  set dlg to display dialog "请输入 Bambook Ops Panel 管理员 Token：" default answer "" with hidden answer with title "Bambook 网页端部署" buttons {"取消", "确定"} default button "确定"
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

# 3) 打包 dist 内容（不含 dist 目录本身这层，方便服务器端直接展开为 webapp/）
# 增量模式（默认）：拉取远端文件清单（webapp-manifest 端点），跳过「同名且同 size」
# 的未变文件——assets/ 为 contenthash 命名，同名即同内容；服务器端 deploy-webapp 的
# 沿用机制（assets 文件级 + data/glyphs/geo/fonts 目录级 + 根级大文件）自动从上一
# 版本补齐被省略的文件。manifest 端点不可用（旧版 OPS Panel）时回退全量。
# 轻量模式（BAMBOOK_WEB_LIGHT=1）：叠加跳过 data/ 与 wallpapers/ 与字体（目录级沿用）。
echo "==> 打包 dist/ → $ARCHIVE"
TAR_EXCLUDES=(--exclude='*.map')
if [[ "${BAMBOOK_WEB_LIGHT:-0}" == "1" ]]; then
  # data/wallpapers 为目录级沿用；assets 下 woff/woff2 字体（content-hash 命名，~35MB）文件级沿用
  TAR_EXCLUDES+=(--exclude='./data' --exclude='./wallpapers' --exclude='*.woff' --exclude='*.woff2')
  echo "==> 轻量模式：跳过 dist/data、dist/wallpapers 与字体文件（服务器沿用现有版本）"
fi

MANIFEST_RESP=$(mktemp)
MANIFEST_HTTP=$(curl --http1.1 -sS -m 30 -o "$MANIFEST_RESP" -w '%{http_code}' \
  -H "X-Bambook-Ops-Token: $OPS_TOKEN" \
  "$OPS_URL/api/admin/webapp-manifest?target=$DEPLOY_TARGET" 2>/dev/null || echo "000")
if [[ "$MANIFEST_HTTP" == "200" ]] && command -v python3 >/dev/null 2>&1; then
  # 远端清单一次性转成 "path<TAB>size" 行表文件（awk 直读文件查表——避免每文件起 python 进程；
  # 也避免 printf 大表管道喂 awk 早退触发 SIGPIPE：pipefail 下 141 会终止整个脚本）
  MANIFEST_TABLE_FILE=$(mktemp)
  python3 -c "
import json
try:
    m = json.load(open('$MANIFEST_RESP')).get('files', {})
    print('\n'.join('%s\t%d' % (k, v) for k, v in m.items()))
except Exception:
    pass
" > "$MANIFEST_TABLE_FILE" 2>/dev/null || true
  # 远端清单 → 逐文件排除（本地 dist 中同名且同 size 的文件视为未变，跳过打包）
  # 注意：查表用 awk 直读文件 + 无匹配返回空串（grep 无匹配返回 1 会被 set -e 终止脚本）
  DIFF_EXCLUDES_FILE=$(mktemp)
  SKIP_COUNT=0
  SKIP_BYTES=0
  TOTAL_COUNT=0
  while IFS= read -r -d '' f; do
    TOTAL_COUNT=$((TOTAL_COUNT + 1))
    rel="${f#dist/}"
    [[ "$rel" == "index.html" ]] && continue  # 入口文件永不跳过
    remote_size=$(awk -F'\t' -v k="$rel" '$1==k{print $2; exit}' "$MANIFEST_TABLE_FILE")
    if [[ -n "$remote_size" ]]; then
      local_size=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
      if [[ "$local_size" == "$remote_size" ]]; then
        echo "./$rel" >> "$DIFF_EXCLUDES_FILE"
        SKIP_COUNT=$((SKIP_COUNT + 1))
        SKIP_BYTES=$((SKIP_BYTES + local_size))
      fi
    fi
  done < <(find dist -type f ! -name '*.map' -print0)
  if [[ "$SKIP_COUNT" -gt 0 ]]; then
    while IFS= read -r excl; do
      TAR_EXCLUDES+=(--exclude="$excl")
    done < "$DIFF_EXCLUDES_FILE"
    SKIP_MB=$(awk -v b="$SKIP_BYTES" 'BEGIN{ printf "%.2f", b/1024/1024 }')
    echo "==> 增量模式：跳过 $SKIP_COUNT/$TOTAL_COUNT 个未变文件（$SKIP_MB MB，仅上传变化部分）"
  else
    echo "==> 增量模式：无已存在的远端文件（首次部署或全部变化），全量打包"
  fi
  rm -f "$DIFF_EXCLUDES_FILE" "$MANIFEST_TABLE_FILE"
else
  echo "==> 增量模式不可用（manifest HTTP $MANIFEST_HTTP），回退全量打包"
fi
rm -f "$MANIFEST_RESP"

tar "${TAR_EXCLUDES[@]}" -czf "$ARCHIVE" -C dist .
SIZE=$(stat -f%z "$ARCHIVE" 2>/dev/null || stat -c%s "$ARCHIVE")
SIZE_MB=$(awk -v b="$SIZE" 'BEGIN{ printf "%.2f", b/1024/1024 }')
echo "==> 包大小: ${SIZE_MB} MB"

# ★ 2026-09-29：只打包模式到此为止（**在取 token 之前就退出**，不碰 keychain、不联网）。
#   闸门与 ops-upload-package.sh 同形：默认 PACK_ONLY=1；要上传必须 --deploy 且 BAMBOOK_ALLOW_DEPLOY=yes。
if [[ "$PACK_ONLY" == "1" ]]; then
  echo "==> 只打包模式：到此为止（没取 token、没联网、没上传）。要真的部署，必须显式给 --deploy 且带 BAMBOOK_ALLOW_DEPLOY=yes。"
  echo "    产物：$ARCHIVE"
  exit 0
fi
if [[ "${BAMBOOK_ALLOW_DEPLOY:-}" != "yes" ]]; then
  echo "error: --deploy 还需要 BAMBOOK_ALLOW_DEPLOY=yes 才会真的上传（这道闸是 2026-09-28 那次误上线之后加的）" >&2
  exit 2
fi

# 4) 上传
# Cloudflare 隧道对 POST body 转发有阈值（实测 >~300KB 易 524/Broken pipe），
# 超过阈值自动切分块上传：/api/admin/deploy-webapp-chunk 逐块 + deploy-webapp-finalize 重组。
CHUNK_THRESHOLD=$((300 * 1024))   # 超过 300KB 走分块
CHUNK_SIZE=$((192 * 1024))        # 每块 192KB（隧道安全阈值内，服务端 limit 500kb）
HTTP_RESP=$(mktemp)

if [[ "$SIZE" -le "$CHUNK_THRESHOLD" ]]; then
  echo "==> 上传到 $OPS_URL/api/admin/deploy-webapp (target=$DEPLOY_TARGET) ..."
  HTTP_CODE=$(curl --http1.1 -sS -m 360 -o "$HTTP_RESP" -w '%{http_code}' \
    -X POST "$OPS_URL/api/admin/deploy-webapp" \
    -H 'Content-Type: application/gzip' \
    -H "X-Bambook-Ops-Token: $OPS_TOKEN" \
    ${DEPLOY_TARGET_HEADER:+-H "$DEPLOY_TARGET_HEADER"} \
    --data-binary "@$ARCHIVE")
else
  # ── 分块上传 ──
  UPLOAD_ID="webapp-$(date +%s)-$RANDOM$RANDOM"
  TOTAL_CHUNKS=$(( (SIZE + CHUNK_SIZE - 1) / CHUNK_SIZE ))
  echo "==> 包大小 ${SIZE_MB} MB 超阈值，分块上传：${TOTAL_CHUNKS} 块 × 192KB (uploadId=$UPLOAD_ID, target=$DEPLOY_TARGET)"

  CHUNK_DIR="$(mktemp -d)"
  split -b "$CHUNK_SIZE" "$ARCHIVE" "$CHUNK_DIR/chunk-"

  CHUNK_INDEX=0
  CHUNK_FAILED=0
  for CHUNK_FILE in "$CHUNK_DIR"/chunk-*; do
    printf '\r==> 上传块 %d/%d ...' "$((CHUNK_INDEX + 1))" "$TOTAL_CHUNKS"
    # 分块级重试：隧道瞬时故障（502/SSL_RESET）一次重试即可扛过，指数退避 3s/9s
    CHUNK_HTTP=""
    for ATTEMPT in 1 2 3; do
      CHUNK_HTTP=$(curl --http1.1 -sS -m 120 -o "$HTTP_RESP" -w '%{http_code}' \
        -X POST "$OPS_URL/api/admin/deploy-webapp-chunk" \
        -H 'Content-Type: application/octet-stream' \
        -H "X-Bambook-Ops-Token: $OPS_TOKEN" \
        -H "X-Upload-Id: $UPLOAD_ID" \
        -H "X-Chunk-Index: $CHUNK_INDEX" \
        -H "X-Total-Chunks: $TOTAL_CHUNKS" \
        ${DEPLOY_TARGET_HEADER:+-H "$DEPLOY_TARGET_HEADER"} \
        --data-binary "@$CHUNK_FILE") && [[ "$CHUNK_HTTP" == "200" ]] && break
      if [[ "$ATTEMPT" -lt 3 ]]; then
        printf '\r==> 块 %d 失败（HTTP %s），%.0fs 后重试 %d/3 ...' "$CHUNK_INDEX" "$CHUNK_HTTP" "$((ATTEMPT * 3))" "$ATTEMPT"
        sleep $((ATTEMPT * 3))
      fi
    done
    if [[ "$CHUNK_HTTP" != "200" ]]; then
      echo ""
      echo "error: 块 $CHUNK_INDEX 上传失败（含 3 次重试，HTTP $CHUNK_HTTP）" >&2
      cat "$HTTP_RESP" >&2
      CHUNK_FAILED=1
      break
    fi
    CHUNK_INDEX=$((CHUNK_INDEX + 1))
  done
  rm -rf "$CHUNK_DIR"

  if [[ "$CHUNK_FAILED" == "1" ]]; then
    unset OPS_TOKEN
    rm -f "$HTTP_RESP"
    osascript -e 'display notification "分块上传中断，去面板看日志" with title "网页端部署失败"' 2>/dev/null || true
    exit 2
  fi

  echo ""
  echo "==> 全部块上传完成，请求重组部署 (finalize)..."
  HTTP_CODE=$(curl --http1.1 -sS -m 360 -o "$HTTP_RESP" -w '%{http_code}' \
    -X POST "$OPS_URL/api/admin/deploy-webapp-finalize" \
    -H 'Content-Type: application/json' \
    -H "X-Bambook-Ops-Token: $OPS_TOKEN" \
    ${DEPLOY_TARGET_HEADER:+-H "$DEPLOY_TARGET_HEADER"} \
    -d "{\"uploadId\": \"$UPLOAD_ID\"}")
fi
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
  osascript -e "display notification \"HTTP ${HTTP_CODE}, 去面板看日志\" with title \"网页端部署失败\"" 2>/dev/null || true
  exit 2
fi

osascript -e 'display notification "网页端已部署（'"$DEPLOY_TARGET"'）" with title "Bambook 网页端"' 2>/dev/null || true
if [[ "$DEPLOY_TARGET" == "webapp-root" ]]; then
  echo "✓ 部署成功 — https://bambook.jiangsupanda.com/（需 Cloudflare Tunnel Public Hostname 已指向 localhost:8081）"
else
  echo "✓ 部署成功 — https://jiangsupanda.com/bambook/api/app/"
fi
