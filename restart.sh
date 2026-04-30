#!/bin/bash
# 重启 CC Hub

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[hub] 重启 Hub..."
"$DIR/stop.sh"
sleep 1
"$DIR/start.sh"
