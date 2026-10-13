#!/bin/bash
# reload-electron.sh — 强制刷新 Bambook Electron 窗口（可靠版）
#
# 三重刷新策略，总有一个生效：
#   1. AppleScript 发 Cmd+R（如果窗口能接收到）
#   2. AppleScript 发 Cmd+Shift+R（Electron 全局快捷键，主进程注册的 reload）
#   3. 提示用户手动按 Cmd+Shift+R
#
# 用法：bash scripts/reload-electron.sh

set -euo pipefail

echo "🔄 正在刷新 Bambook 窗口..."

# 方案 1+2：同时发 Cmd+R 和 Cmd+Shift+R
osascript <<'APPLESCRIPT' 2>/dev/null || true
tell application "System Events"
    set procList to (every process whose name contains "Electron" or name contains "bambook" or name contains "Bambook")
    if (count of procList) > 0 then
        set targetProc to item 1 of procList
        set frontmost of targetProc to true
        delay 0.3
        -- 先试全局快捷键 Cmd+Shift+R（Electron 主进程注册的）
        keystroke "r" using {command down, shift down}
        delay 0.1
        -- 再兜底 Cmd+R（浏览器原生刷新）
        keystroke "r" using command down
        return "ok"
    end if
end tell
APPLESCRIPT

echo "✅ 刷新指令已发送（Cmd+Shift+R + Cmd+R 双发）"
echo "   如果窗口仍然没更新，请手动在 Bambook 窗口按 Cmd+Shift+R"
