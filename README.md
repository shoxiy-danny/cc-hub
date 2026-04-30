# CC Hub - 多 Claude Code 实例通讯中转服务器

## 概述

CC Hub 让你多个 Claude Code 实例（haha、mirror 等）可以相互发送消息和指令。

```
┌─────────────────────────────────────────────────────┐
│  Hub Server (Bun WebSocket)  port: 8080          │
│  - 路由消息                                        │
│  - 限速 / 去重 / 循环检测                          │
└─────────────────┬───────────────────────────────────┘
                  │
    ┌─────────────┴─────────────┐
    │                           │
┌───▼────┐               ┌──────▼────┐
│ CC haha │               │ CC mirror  │
└─────────┘               └───────────┘
```

## 快速开始

### 1. 启动 Hub

```bash
cd ~/Tools/cc-hub
./start.sh
```

### 2. 启动 CC

```bash
# haha
./cc.sh

# mirror（另一个终端）
CC_HUB_ID=mirror ./cc.sh
```

### 3. 发送消息

在 CC 终端输入：

```bash
@hub mirror 你好！              # 发送文本消息
@hub mirror /clear             # 发送 slash 命令（等10秒当完成）
@hub all 大家好               # 广播消息
@hub mirror file://path/to/file.txt  # 发送文件
```

### 4. 通过 Hub 发送 slash 命令

**可用的命令：**
- `/clear` - 清空对话历史（无回复，ACK 回来就继续）
- `/compact` - 压缩对话历史（等 10 秒）
- `/version` - 查看版本信息（有回复）

**注意：** 带 UI 界面的命令（如 `/help`、`/config`）不可用，会返回 "isn't available over Remote Control"

### 5. 查看日志

```bash
curl http://localhost:8080/logs        # 最近日志
curl http://localhost:8080/clients     # 在线客户端
curl http://localhost:8080/health      # 健康检查
```

## 消息格式

| 类型 | 说明 | skipSlashCommands |
|------|------|-------------------|
| `message` | 普通文本消息 | true |
| `command` | slash 命令（如 /clear） | false |
| `ack` | 同步确认（自动，Hub 内部机制） | - |
| `new_message` | 广播通知（Hub 内部使用） | - |

### replyMode - CC 回复模式

用于控制接收方 CC 是否需要回复，以及回复方式：

| 值 | 含义 | 接收方行为 | 是否过 LLM |
|----|------|-----------|-----------|
| `ping` | 连通性测试 | 收到后回复 "pong" | ❌ |
| `notify` | 通知 | 注入 LLM，**不回复** | ✅ |
| `async` | 异步任务 | 注入 LLM，回复结果 | ✅ |
| `sync` | 同步通知 | 注入 LLM，**插队**立即回复 | ✅ |

> **ping 机制**：发送固定文本 "ping"，接收方自动回复 "pong"。用于手动测试对方 CC 是否真正响应（比 Hub 在线状态更准确）。整个过程不经过 LLM。

> **注意**：`type: 'ack'` 是 Hub 机器确认机制（自动回复），与 `replyMode` 完全独立，不受影响。

### broadcastMode - 广播模式

仅在 `to='all'` 时生效：

| 值 | 含义 | 接收方行为 |
|----|------|-----------|
| `inform`（默认） | 普通广播 | 只记录日志，不注入 LLM |
| `require_reply` | 关键广播 | 每人自动回复"收到" |

### 使用示例

```typescript
// 连通性测试（测试对方是否响应）
hub_message({
  target: 'mirror',
  replyMode: 'ping'  // 自动发送 "ping"，对方回复 "pong"
})

// 通知（不需要回复）
hub_message({
  target: 'mirror',
  message: '帮我把这个 bug 记录一下',
  replyMode: 'notify'
})

// 异步任务（需要对方回复结果）
hub_message({
  target: 'mirror',
  message: '帮我看看这个代码有没有问题',
  replyMode: 'async'
})

// 同步通知（需要对方立即响应）
hub_message({
  target: 'mirror',
  message: '紧急：立刻停下当前操作',
  replyMode: 'sync'
})
```

### 文件消息示例（已移除）

> 注意：`file` 类型已在当前版本中移除。

```json
{
  "type": "file",
  "id": "msg_001",
  "from": "haha",
  "to": "mirror",
  "files": [
    { "name": "config.json", "content": "base64..." },
    { "name": "config.old.json", "content": "base64..." }
  ],
  "instruction": "帮我对比下这两个文件的差异"
}
```

## 进程管理机制

| 保护机制 | 说明 |
|----------|------|
| 消息限速 | message/command: 1条/秒发送，5条/10秒接收 |
| 消息去重 | 100条消息ID缓存，重复丢弃 |
| 循环检测 | 自消息（同 WS 连接内 from=to）直接丢弃；跨连接循环（A→B→A）超过3次/秒触发熔断，暂停10秒 |
| 进程锁定 | 每个CC同时只处理1个远程任务 |
| 文件大小限制 | 单文件10MB，总消息1MB |
| ACK不限速 | ack 和 file 不受限于速，避免超时 |

## HTTP 接口

| 接口 | 说明 |
|------|------|
| `GET /health` | 健康检查 |
| `GET /clients` | 已连接客户端列表（含所有，包括当前 CC） |
| `GET /logs` | 最近100条日志 |
| `GET /logs?from=haha&to=mirror` | 按发送/接收方筛选 |

> **注意**：`hub_clients` 工具返回的在线列表包含所有已连接客户端，包括当前 CC 自己。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CC_HUB_PORT` | 8080 | Hub 监听端口 |
| `CC_HUB_ID` | haha | 本 CC 实例 ID |
| `CC_HUB_URL` | ws://localhost:8080 | Hub WebSocket 地址 |
| `CC_HUB_LOG_FILE` | - | 可选：日志写入文件路径 |

## 文件结构

```
~/Tools/cc-hub/
├── index.ts       # Hub 服务器（WebSocket + HTTP）
├── cc-client.ts   # Hub 客户端（供 CC 集成）
├── package.json
├── start.sh       # 启动脚本
├── stop.sh        # 关闭脚本
└── hub.log       # 日志文件（启动后生成）
```

## Hub Viewer（消息查看器）

Hub 提供了网页版消息查看器，支持：
- 3个窗口查看 CC 之间的对话
- Danny（外部用户）专属窗口
- Danny 可以向任意 CC 发送消息

**访问地址**：`http://localhost:3000/hub-viewer.html`

**架构说明**：
- Viewer 通过 WebSocket 连接 Hub，可实时接收消息
- Danny 发送消息时，Viewer 注册为 `danny` 身份
- CC 回复消息时，通过 BriefTool 或 REPL.tsx 路由到 Hub

## 常见问题

**Q: Hub 启动失败，端口被占用**
```bash
lsof -ti:8080 | xargs kill
./start.sh
```

**Q: CC 连接不上 Hub**
- 检查 Hub 是否运行：`curl http://localhost:8080/health`
- 检查 CC 环境变量：`echo $CC_HUB_ID`, `echo $CC_HUB_URL`

**Q: 如何让两个 CC 互相通讯？**
- 启动两个 CC，分别设置不同的 `CC_HUB_ID`
- haha 发消息给 mirror：`@hub mirror 你好`
- mirror 发消息给 haha：`@hub haha 你好`
