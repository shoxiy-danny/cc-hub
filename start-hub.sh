#!/bin/bash
# Hub 后台启动脚本
# 供多个 CC 实例调用，通过 mkdir 原子锁防止重复启动
# 使用 nohup 启动，不依赖终端

set -e

HUB_DIR="$HOME/Tools/cc-hub"
LOCKDIR=/tmp/cc-hub-starting.lock
LOG_FILE="$HUB_DIR/hub.log"
HUB_URL="${CC_HUB_URL:-ws://localhost:8080}"
HEALTH_URL="http://localhost:8080/health"

# 快速检查：已在运行则直接返回
if curl -s "$HEALTH_URL" > /dev/null 2>&1; then
    echo "[hub] Already running"
    exit 0
fi

# 原子锁：mkdir 只能被一个进程创建成功
if ! mkdir "$LOCKDIR" 2>/dev/null; then
    echo "[hub] Another CC process is starting Hub, waiting..."
    for i in $(seq 1 10); do
        if curl -s "$HEALTH_URL" > /dev/null 2>&1; then
            echo "[hub] Ready (started by another CC)"
            exit 0
        fi
        sleep 1
    done
    echo "[hub] Timeout waiting for Hub to start"
    exit 1
fi

# 确保退出时清理锁目录
trap 'rm -rf "$LOCKDIR"' EXIT

# 后台启动 Hub（nohup 脱离终端）
echo "[hub] Starting Hub..."
cd "$HUB_DIR"
nohup /home/danny/.bun/bin/bun run index.ts > "$LOG_FILE" 2>&1 &

# 等待就绪
for i in $(seq 1 10); do
    if curl -s "$HEALTH_URL" > /dev/null 2>&1; then
        echo "[hub] Started and ready"
        exit 0
    fi
    sleep 1
done

echo "[hub] Warning: process started but health check not responding yet"
exit 0
