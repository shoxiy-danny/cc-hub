#!/bin/bash
# 关闭 CC Hub

pkill -f "bun run index.ts" && echo "Hub 已关闭" || echo "Hub 未运行"
