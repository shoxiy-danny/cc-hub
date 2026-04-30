#!/bin/bash
# 停止 Hub 后台进程

set -e

LOCKDIR=/tmp/cc-hub-starting.lock

PID=$(pgrep -f "cc-hub/index.ts" | head -1)

if [ -z "$PID" ]; then
    echo "[hub] Not running"
    rm -rf "$LOCKDIR"
    exit 0
fi

echo "[hub] Stopping (PID $PID)..."
kill "$PID"

# 等最多5秒
for i in $(seq 1 5); do
    if ! kill -0 "$PID" 2>/dev/null; then
        echo "[hub] Stopped"
        rm -rf "$LOCKDIR"
        exit 0
    fi
    sleep 1
done

# 未退出则强制终止
echo "[hub] Force killing..."
kill -9 "$PID" 2>/dev/null || true
rm -rf "$LOCKDIR"
echo "[hub] Stopped"
