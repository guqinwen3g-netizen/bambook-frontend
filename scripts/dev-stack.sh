#!/usr/bin/env bash
# Web 开发全栈入口：一键启动本地后端 + 全部前端程序。
#
# 2026-09-11 调整（此前只起前端、业务走数据中心）：
#  1. 调试面板依赖本地后端的 /api/dev 路由（BAMBOOK_DEV_PANEL=1 且非 production
#     才生效，见 server/src/devPanel/route.ts）；数据中心是 production，接口 404，
#     面板永远只剩「未启用」提示。所以 dev 环境必须起本地后端（8081）。
#  2. 项目是多程序形态（主程序 + 客户程序，后续还有供应商程序），dev 时全部拉起，
#     就绪后逐个打开浏览器。
#
# 新增程序时只需在 APPS 清单里加一行 "端口|目录|说明"。

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# 在清场前校验后端 env，避免 npm run dev 意外接入旧库或其他环境。
SERVER_DB="$(node -e 'const fs=require("fs"); const line=fs.readFileSync("server/.env","utf8").split(/\r?\n/).find(x=>/^\s*DATABASE_URL\s*=/.test(x))||""; try { console.log(new URL(line.slice(line.indexOf("=")+1).trim().replace(/^"|"$/g, "")).pathname.slice(1)); } catch { process.exit(2); }' 2>/dev/null)" || true
if [ "$SERVER_DB" != "panda_hub_dev" ]; then
    echo ">>> [dev-stack] 拒绝启动：server/.env DATABASE_URL 必须指向 panda_hub_dev（当前: ${SERVER_DB:-无法解析}）"
    exit 1
fi

# 前端程序清单：端口|相对目录|打开路径|说明
APPS=(
    "3000|.|/|主程序"
    "3005|customer-portal|/|客户程序"
    # "3015|supplier-portal|/|供应商程序"   # 待建，建好后去掉注释即可
)
BACKEND_PORT=8081
LAUNCHD_LABEL="gui/$(id -u)/com.bambook.dev-server"
BACKEND_MANAGED=0
if [[ "$(uname -s)" == "Darwin" ]] && launchctl print "$LAUNCHD_LABEL" >/dev/null 2>&1; then
    BACKEND_MANAGED=1
fi

# ---------- 清场 ----------
# 杀掉旧的 vite/server 进程和占用端口，避免 Vite fall-through 到 3001/3002
# 导致用户打开浏览器看到的是上次残留的实例。
echo ">>> [dev-stack] 清场旧进程"
pkill -f "apps/Bambook/node_modules/.bin/vite" 2>/dev/null || true
pkill -f "apps/Bambook/customer-portal/node_modules/.bin/vite" 2>/dev/null || true
if [ "$BACKEND_MANAGED" = "0" ]; then
    pkill -f "apps/Bambook/server/src/index.ts" 2>/dev/null || true
fi
PORTS="$(printf '%s\n' "${APPS[@]}" | cut -d'|' -f1)"
if [ "$BACKEND_MANAGED" = "0" ]; then
    PORTS="$BACKEND_PORT $PORTS"
fi
for port in $PORTS; do
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        echo "    端口 $port 被占，kill: $pids"
        kill -9 $pids 2>/dev/null || true
    fi
done
sleep 0.5

mkdir -p logs

# ---------- 本地 Agent ----------
# 浏览器开发版同样使用完整 Web UI + Rust 服务，不需要 Electron 或打包。
# 不自动触发重型 prepare；未构建/端口冲突会记录在独立日志中。
source "$ROOT/scripts/openbitfun-dev.sh"
trap 'stop_openbitfun_dev' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
start_openbitfun_dev "$ROOT"

# ---------- 本地后端 ----------
# server/.env 指向唯一开发库 panda_hub_dev，并启用调试面板。
# 前端经 VITE_API_BASE_URL=/api 走 vite proxy → 8081，账号/业务/调试面板全部本地可用。
if [ "$BACKEND_MANAGED" = "1" ]; then
    echo ">>> [dev-stack] 使用 launchd 本地后端 (端口 $BACKEND_PORT, 数据库 panda_hub_dev, 调试面板 BAMBOOK_DEV_PANEL=1)"
else
    echo ">>> [dev-stack] 启动本地后端 (端口 $BACKEND_PORT, 数据库 panda_hub_dev, 调试面板 BAMBOOK_DEV_PANEL=1)"
    (cd server && nohup npm run dev > ../logs/dev-server.log 2>&1 &)
fi

# ---------- 前端程序 ----------
echo ">>> [dev-stack] 启动前端程序"
for entry in "${APPS[@]}"; do
    IFS='|' read -r port dir path label <<< "$entry"
    if [ ! -f "$ROOT/$dir/package.json" ] && [ "$dir" != "." ]; then
        echo "    [跳过] $label：$dir 尚不存在"
        continue
    fi
    echo "    启动 $label (端口 $port, 目录 $dir)"
    if [ "$dir" = "." ]; then
        # 主程序：显式走本地后端代理（优先级高于浏览器 localStorage 里的数据中心地址）
        VITE_API_BASE_URL="/api" nohup npm run dev:web > logs/dev-main.log 2>&1 &
    else
        (cd "$dir" && nohup npm run dev > "../logs/dev-${dir}.log" 2>&1 &)
    fi
done

# ---------- 等服务就绪再逐个开浏览器 ----------
# 后端 ts-node 冷启动较慢；最长等 90s，超时不报错，让用户手动打开。
(
    backend_ready=0
    for _ in $(seq 1 180); do
        if [ "$backend_ready" = "0" ] && lsof -ti tcp:"$BACKEND_PORT" >/dev/null 2>&1; then
            backend_ready=1
            echo ">>> [dev-stack] 本地后端已就绪 (端口 $BACKEND_PORT)"
        fi
        all_ok=1
        for entry in "${APPS[@]}"; do
            IFS='|' read -r port dir path label <<< "$entry"
            curl -sSf -o /dev/null --max-time 1 "http://localhost:${port}/" 2>/dev/null || all_ok=0
        done
        if [ "$all_ok" = "1" ]; then
            for entry in "${APPS[@]}"; do
                IFS='|' read -r port dir path label <<< "$entry"
                [ -d "$ROOT/$dir" ] || continue
                open "http://localhost:${port}${path}"
            done
            exit 0
        fi
        sleep 0.5
    done
    echo ">>> [dev-stack] 90s 内未全部就绪，请手动打开或查看 logs/dev-*.log"
) &

# 业务服务保持原有 nohup 行为；Ctrl+C 只额外停止本次拥有的 Agent 及其子进程。
echo ">>> [dev-stack] 全部已拉起，日志: logs/dev-server.log / logs/dev-main.log / logs/dev-customer-portal.log / logs/dev-openbitfun.log"
echo ">>> [dev-stack] Agent 入口：主程序左侧「平台」→「AI 助手（开发中）」；Ctrl+C 会停止本次启动的 Agent"
tail -f logs/dev-main.log
