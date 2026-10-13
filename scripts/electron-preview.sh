#!/usr/bin/env bash
# Electron Production Preview 栈：清场 → 后台起 Express API (:8081) → build
# renderer (electron-vite build) → 启动 Electron 加载已 build 的静态文件 →
# 自动聚焦窗口。
#
# 与 electron-stack.sh 的区别：
#   • 用 production build（minified, no StrictMode double render, no
#     sourcemap overhead）→ 性能等同最终 DMG
#   • 没有 HMR，改代码后必须重新跑这个脚本
#   • 适合：演示给别人看 / 评估真实性能 / 测试发布版本
#
# ELECTRON_RUN_AS_NODE 同样必须 unset。

set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

unset ELECTRON_RUN_AS_NODE

# ---------- 清场 ----------
echo ">>> [electron-preview] 清场旧进程"
pkill -f "apps/Bambook/node_modules/electron/dist/Electron.app" 2>/dev/null || true
pkill -f "electron-vite/bin/electron-vite.js" 2>/dev/null || true
pkill -f "apps/Bambook/server/.*nodemon" 2>/dev/null || true
for port in 8081 3000 3001 3002; do
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        echo "    端口 $port 被占，kill: $pids"
        kill -9 $pids 2>/dev/null || true
    fi
done
sleep 0.5

# ---------- 启动 ----------
echo ">>> [electron-preview] 启动 API server (background, :8081)"
(cd "$ROOT/server" && npm run dev) &
API_PID=$!

cleanup() {
    echo ""
    echo ">>> [electron-preview] 收尾，杀 API (pid=$API_PID)"
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---------- 后台聚焦窗口 ----------
(
    for _ in $(seq 1 60); do
        if pgrep -f "apps/Bambook/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" >/dev/null 2>&1; then
            sleep 1
            osascript -e 'tell application "System Events" to set frontmost of every process whose name is "Electron" to true' >/dev/null 2>&1 || true
            exit 0
        fi
        sleep 0.5
    done
) &

# ---------- Build renderer ----------
echo ">>> [electron-preview] 构建生产包 (electron-vite build)"
echo "    (修改代码后需要重新运行这个脚本以重新构建)"
node node_modules/electron-vite/bin/electron-vite.js build

# ---------- 启动 Electron ----------
echo ">>> [electron-preview] 启动 Electron 加载已构建的静态文件"
exec node node_modules/electron-vite/bin/electron-vite.js preview
