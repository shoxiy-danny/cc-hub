#!/bin/bash
# 启动 CC Hub（后台运行）

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="${DIR}/hub.log"
PID_FILE="${DIR}/hub.pid"

# 检查是否已在运行
if curl -s http://localhost:8080/health > /dev/null 2>&1; then
    echo "Hub 已在运行"
    exit 0
fi

# 启动 Hub
cd "$DIR"
bun run index.ts > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "Hub 已启动 (PID: $(cat $PID_FILE))"
echo "日志: $LOG_FILE"
echo "查看日志: tail -f $LOG_FILE"
echo "关闭: ./stop.sh"
