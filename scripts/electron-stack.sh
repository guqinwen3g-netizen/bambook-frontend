#!/usr/bin/env bash
# Electron 开发栈：只启动 Electron/renderer，业务数据和 Agent API 走数据中心。
#
# 设计要点：
#   • 启动前只清理主程序自己占用的 API (:8081) 与 renderer (:3000)
#     端口。UI Lab Electron dev 固定走 :3100，需要能和主程序并行打开。
#   • Ctrl+C / Electron 窗口关闭 / 终端关闭 都会触发 trap，杀掉 API 子进程。
#   • ELECTRON_RUN_AS_NODE 必须 unset —— Cursor IDE shell 会注入这个变量
#     让所有 Electron 二进制以 Node 模式运行，会让主进程加载失败。
#     同样的 unset 也内置在 npm script 里，这里加一道保险。

set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

unset ELECTRON_RUN_AS_NODE

# ---------- 清场 ----------
# 清掉主程序自己的 Electron / electron-vite 旧栈。这里不能只清 PPID=1 的
# 孤儿进程：如果旧 dev stack 还挂在另一个 terminal 下，Electron 的
# single-instance lock 会让新启动直接聚焦旧窗口，导致主进程代码改了也不生效。
echo ">>> [electron-stack] 清场旧进程"
# 只清 renderer 端口为 3000 的主程序，避免误杀 UI Lab Electron(:3100)。
while read -r pid; do
    [ -n "$pid" ] || continue
    env_line="$(ps eww -p "$pid" 2>/dev/null || true)"
    if printf '%s' "$env_line" | grep -q "ELECTRON_RENDERER_URL=http://localhost:3000"; then
        echo "    清理旧 Bambook Electron 主进程: $pid"
        kill "$pid" 2>/dev/null || true
    fi
done < <(
    pgrep -afil "apps/Bambook/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \\." \
        | awk '{ print $1 }'
)
while read -r pid; do
    [ -n "$pid" ] || continue
    env_line="$(ps eww -p "$pid" 2>/dev/null || true)"
    if ! printf '%s' "$env_line" | grep -q "BAMBOOK_ELECTRON_UI_LAB=1"; then
        echo "    清理旧 electron-vite dev 进程: $pid"
        kill "$pid" 2>/dev/null || true
    fi
done < <(
    pgrep -afil "apps/Bambook/node_modules/.bin/electron-vite dev" \
        | awk '{ print $1 }'
)
# 杀掉旧的本地后端残留，避免误连本地业务库。
pkill -f "apps/Bambook/server/.*nodemon" 2>/dev/null || true
# 端口兜底：只清主程序端口，不能碰 UI Lab 的 3100。
for port in 8081 3000; do
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        echo "    端口 $port 被占，kill: $pids"
        kill -9 $pids 2>/dev/null || true
    fi
done

# Vite stores optimized dependency output under node_modules/.vite.  A package
# install can leave this cache referring to an old dependency graph, which
# makes the renderer return 504 "Outdated Optimize Dep" responses and leaves
# Electron with a blank window.  This cache is fully generated, so invalidate
# it before each dedicated Electron dev launch instead of relying on a manual
# browser hard-refresh.
if [ -d "$ROOT/node_modules/.vite" ]; then
    echo ">>> [electron-stack] 失效 Vite 依赖缓存"
    rm -rf "$ROOT/node_modules/.vite"
fi
sleep 0.5

trap 'true' EXIT INT TERM

# 后台轮询：Electron 进程出现后把本次启动的窗口拉到最前。
# 不能按进程名激活：开发机可同时有多个名为 Electron 的应用，宽泛匹配会
# 把无关的示例窗口置顶，遮住 Bambook 并制造“白屏”的假象。按 Unix PID 定位。
(
    for _ in $(seq 1 60); do
        main_pid="$(pgrep -f "apps/Bambook/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \\." | head -n 1 || true)"
        if [ -n "$main_pid" ]; then
            sleep 1
            osascript - "$main_pid" >/dev/null 2>&1 <<'APPLESCRIPT' || true
on run argv
    tell application "System Events"
        set frontmost of first process whose unix id is (item 1 of argv as integer) to true
    end tell
end run
APPLESCRIPT
            exit 0
        fi
        sleep 0.5
    done
) &

echo ">>> [electron-stack] 启动 electron-vite dev (renderer + 主进程 + 窗口)"
exec npm run electron:dev
