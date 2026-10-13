#!/usr/bin/env bash
# Sourced by dev-stack: retain the resource-guarded runtime as an owned child.
# Never build automatically, adopt another host, or clear the Agent's ports.
OPENBITFUN_DEV_PID=""

openbitfun_dev_is_running() {
    [ -n "$OPENBITFUN_DEV_PID" ] && jobs -pr | grep -Fx "$OPENBITFUN_DEV_PID" >/dev/null
}

start_openbitfun_dev() {
    local root="$1"
    if openbitfun_dev_is_running; then
        return 0
    fi
    mkdir -p "$root/logs"
    echo ">>> [dev-stack] 启动本地 OpenBitFun（AI 助手，端口 1422/8080，内存保护开启）"
    node --max-old-space-size=128 "$root/scripts/start-openbitfun.mjs" --dev > "$root/logs/dev-openbitfun.log" 2>&1 &
    OPENBITFUN_DEV_PID=$!
}

stop_openbitfun_dev() {
    # jobs checks ownership and completion, not merely whether a PID exists.
    # This avoids signalling a reused PID or an independently started Agent.
    if openbitfun_dev_is_running; then
        kill -TERM "$OPENBITFUN_DEV_PID" 2>/dev/null || true
        wait "$OPENBITFUN_DEV_PID" 2>/dev/null || true
    fi
    OPENBITFUN_DEV_PID=""
}
