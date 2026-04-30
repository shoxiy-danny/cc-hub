# CC Hub 通讯架构实现计划 v2

## Context

在 CC-haha 项目中实现一个 Hub，让多个 Claude Code 实例（haha、mirror 等）可以：
1. 相互发送指令（如 `/clear`）
2. 通过消息协作
3. 避免进程循环调用、CPU 跑满等风险

## 架构设计

```
┌─────────────────────────────────────────────────────┐
│  Hub Server (Bun WebSocket)  port: 8080            │
│  - 路由消息                                         │
│  - 限速（消息频率控制）                              │
│  - 去重（防止重复消息）                               │
└─────────────────┬───────────────────────────────────┘
                  │
    ┌─────────────┴─────────────┐
    │                           │
┌───▼────┐               ┌──────▼────┐
│ CC haha │               │ CC mirror │
└─────────┘               └───────────┘
```

## CC 工具层

CC 通过工具调用 Hub 能力，像使用 Web Search 一样自主调用。

### hub_clients — 查看在线实例
```typescript
{
  name: "hub_clients",
  description: "查看当前连接到 Hub 的其他 CC 实例（不包括自己）。用于确定可以协作的对象。",
  parameters: {}
}
```
返回：`{ clients: string[], total: number }`（已过滤掉自身）

实现：调 `GET http://localhost:8080/clients`，自动过滤掉 `CC_HUB_ID`

### hub_message — 发消息
```typescript
{
  name: "hub_message",
  description: "通过 Hub 发送消息给另一个 CC 实例。用于团队协作。",
  parameters: {
    target: { type: "string", description: "目标实例 ID" },
    message: { type: "string", description: "消息内容" }
  }
}
```
发送后等待 ACK（3秒超时）。
- `received`：对方已收到，继续等回复
- `offline`：对方不在线，不用等了

工具**同步**返回 ACK 结果，**异步**等对方回复消息。对方处理完成后会主动发 `message` 回来，该消息以 `<channel source="hub">` 的形式注入当前 CC 会话，作为一条独立的新消息出现。

### 工具注册

工具在 CC 源码中注册，位于 `src/tools/` 目录：

```
src/tools/
├── index.ts          # 工具注册入口
├── HubClientsTool.ts # hub_clients 实现
└── HubMessageTool.ts # hub_message 实现
```

参考现有工具（如 Web Search）的注册方式。

## 消息格式

### 1. 文本消息
```json
{
  "type": "message",
  "id": "msg_001",           // 唯一ID，用于ACK
  "from": "haha",
  "to": "mirror",            // 或 "all" 表示广播
  "content": "你好，帮我看看这个文件有什么问题",
  "timestamp": 1745460000000
}
```

### 2. 指令消息（slash 命令）
```json
{
  "type": "command",
  "id": "msg_002",
  "from": "haha",
  "to": "mirror",
  "content": "/clear",
  "timestamp": 1745460000000
}
```

### 3. ACK 消息（同步确认）
```json
{
  "type": "ack",
  "id": "msg_001",           // 对应原始消息ID
  "from": "mirror",
  "status": "received" | "offline"
}
```

> **结果怎么返回？**：异步。处理完后直接发一条普通 `message` 给对方，不需要特殊类型。

## 通讯日志

Hub 维护所有消息日志，供调试和追踪使用。

### 日志格式（人类可读）
```typescript
interface LogEntry {
  id: string          // 消息ID
  time: string        // ISO 时间
  from: string        // 发送方
  to: string          // 接收方
  type: 'message' | 'command' | 'ack'
  preview: string     // 内容预览（前100字符）
  status: 'ok' | 'rate_limited' | 'not_found'
}
```

### 日志查看

Hub 提供简单 HTTP 接口：
```
GET http://localhost:8080/health        # 健康检查
GET http://localhost:8080/clients        # 在线客户端列表
GET http://localhost:8080/logs           # 查看最近100条
GET http://localhost:8080/logs?from=haha&to=mirror  # 按发送/接收方筛选
```

终端查看：
```bash
curl http://localhost:8080/logs | jq .
```

### 日志存储
- 内存中维护最近 1000 条
- 默认写入文件：`hub.log`（进程目录）
- 可选覆盖路径：`CC_HUB_LOG_FILE=/path/to/log.txt`

## 进程管理机制

### 1. 消息限速（Throttling）
```
每种消息类型区别处理：
  - message/command: 发送 1条/秒，接收 5条/10秒
  - ack: 不限速（轻量同步确认，block 会导致超时）

超出限制 → Hub 返回 "rate_limited"，发送方等待
```

### 2. 消息去重（Deduplication）
```
每条消息有唯一 ID
Hub 维护最近 100 条消息 ID 集合
收到重复 ID → 丢弃，不转发
```

### 3. CPU/内存保护
```
Hub 进程:
  - 单消息内容限制: 1MB
  - 消息队列长度: 1000
  - 超过 → 返回 error
```

## Hub 服务器实现

**文件**: `~/Tools/cc-hub/index.ts`

```typescript
// 核心数据结构
interface Client {
  ws: WebSocket
  id: string
  lastMessageTime: number
  messageCount: number  // 滑动窗口计数
}

const clients = new Map<string, Client>()
const recentMessageIds = new Set<string>()  // 去重
const logs: LogEntry[] = []  // 通讯日志
```

**Hub 同时提供 HTTP 接口**：
```typescript
// Bun 原生支持，在同一端口上同时处理 HTTP 和 WebSocket
Bun.serve({
  port: 8080,
  fetch(req, server) {
    if (req.url.startsWith('/health')) {
      return Response.json({ status: 'ok' })
    }
    if (req.url.startsWith('/clients')) {
      return Response.json({ clients: [...clients.keys()], total: clients.size })
    }
    if (req.url.startsWith('/logs')) {
      return Response.json(logs.slice(-100))
    }
    // WebSocket 升级
    return server.upgrade(req)
  },
  websocket: { /* WebSocket 处理 */ }
})
```
限速配置:
```typescript
const RATE_LIMIT = {
  SEND_INTERVAL_MS: 1000,      // 发送间隔
  RECEIVE_WINDOW_MS: 10000,    // 接收滑动窗口
  RECEIVE_MAX: 5,              // 窗口内最多5条
}
```

## Hub 客户端实现

**文件**: `~/Tools/cc-hub/cc-client.ts`

Hub 客户端**不独立起进程**，而是作为 CC 主进程的异步模块运行。

```typescript
class HubClient {
  private ws: WebSocket | null = null
  private pendingAcks = new Map<string, (ack: Ack) => void>()

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.hubUrl)
    this.ws.addEventListener('open', () => this.register())
    this.ws.addEventListener('message', (e) => this.onMessage(e.data))
    this.ws.addEventListener('close', () => this.onDisconnect())
  }

  // 注册本机 CC ID
  private register() {
    this.send({ type: 'register', id: this.id })
  }

  // 发送消息并等待 ACK
  async sendAndWait(msg: Message, timeoutMs = 3000): Promise<Ack> {
    const ack = await Promise.race([
      this.waitForAck(msg.id),
      this.timeout(timeoutMs)
    ])
    return ack
  }

  // 收到 Hub 消息
  private onMessage(data: string) {
    const msg = JSON.parse(data)
    if (msg.type === 'ack') {
      const resolver = this.pendingAcks.get(msg.id)
      if (resolver) { resolver(msg); this.pendingAcks.delete(msg.id) }
    } else if (msg.type === 'message') {
      // 普通文本：直接注入会话
      this.injectText(msg.content)
    } else if (msg.type === 'command') {
      // slash 命令：注入并允许执行
      this.injectCommand(msg.content)
    }
  }

  private injectText(content: string) {
    enqueue({
      value: `<channel source="hub">${content}</channel>`,
      mode: 'prompt',
      skipSlashCommands: true  // 文本不走 slash 命令解析
    })
    void run()
  }

  private injectCommand(content: string) {
    enqueue({
      value: `<channel source="hub">${content}</channel>`,
      mode: 'prompt',
      skipSlashCommands: false  // 命令需要解析 slash
    })
    void run()
  }

  // 断开连接
  async disconnect() {
    this.ws?.close()
    this.ws = null
  }

  // CC 退出时自动清理
  process.on('exit', () => this.disconnect())
}
```

**断开重连**：
- WebSocket 断开后，每 5 秒自动尝试重连
- 重连成功后自动重新注册 CC ID
- 重连期间不影响 CC 正常运行

**为什么不用独立进程**：
- 独立进程 → CC 崩溃时变成孤儿进程，需额外进程管理
- 同进程异步 → CC 退出时自然一起退出，无孤儿风险
- 代码更简单，共用 CC 的事件循环

## CC 集成

**修改**: `~/claude-code-haha-main/src/cli/print.ts`

在 `enableRemoteControl` 分支（约3900行）添加：
```typescript
// Hub 客户端初始化
if (process.env.CC_HUB_ID && process.env.CC_HUB_URL) {
  const hubClient = new HubClient({
    id: process.env.CC_HUB_ID,
    hubUrl: process.env.CC_HUB_URL,
    onInject: (content) => {
      enqueue({ value: content, mode: 'prompt' })
      void run()
    }
  })
  await hubClient.connect()

  // CC 退出时自动断开 Hub 连接（防止半开连接）
  process.on('exit', () => hubClient.disconnect())
}
```

**进程安全**：
- Hub 客户端运行在 CC 主进程内，不是独立进程
- CC 退出时 `process.on('exit')` 触发 `hubClient.disconnect()`
- CC 崩溃时，操作系统会自动关闭整个进程树，无孤儿

## 环境变量

```env
CC_HUB_ID=haha                    # 本实例 ID
CC_HUB_URL=ws://localhost:8080    # Hub 地址
CC_HUB_ENABLED=true               # 启用 Hub 通讯
```

## 用户交互

### 发送消息
```
@hub mirror 你好，帮我看看这个？     # 文本消息（message）
@hub all 大家好                      # 广播（message）
@hub mirror /clear                   # 指令消息（command）
```

### 返回结果
```
# 直接发文本消息回去即可
@hub haha 修改完成，新内容如下：
[结果内容]
```

### Hub 管理命令
```
@hub status      # 查看已连接CC列表
@hub disconnect  # 断开Hub连接
```

## 实现顺序

1. Hub 服务器核心 (`~/Tools/cc-hub/index.ts`)
   - WebSocket 服务器
   - 客户端注册/注销
   - 消息路由
   - 限速 + 去重
   - ACK 状态（received/offline）

2. Hub 客户端 (`~/Tools/cc-hub/cc-client.ts`)
   - 连接/重连
   - 消息发送/ACK 等待（3秒超时）
   - 注入到本地 CC

3. CC 集成 (`print.ts`)
   - Hub 客户端初始化
   - 环境变量读取

4. CC 工具实现 (`src/tools/`)
   - `HubClientsTool.ts`
   - `HubMessageTool.ts`
   - 工具注册

5. 测试验证
   - haha ↔ mirror 双向通讯
   - hub_clients 工具调用
   - hub_message 工具调用
   - 限速测试

## 关键代码路径

- CC 消息入队: `print.ts` 约3923行 `enqueue({ value: content, mode: 'prompt' })`
- Slash 命令解析: `processUserInput.ts:430-461` 的 `<channel>` 标签解析
- WebSocket 客户端: `src/cli/transports/WebSocketTransport.ts`

## 安全性

- **当前**：所有 CC 在同一台机器本地运行，不对外暴露，不需要身份验证
- **将来**：扩展到跨机器时，添加 token 或白名单机制

## 风险控制总结

| 风险 | 解决方案 |
|------|----------|
| CPU 跑满 | 消息限速 |
| 消息堆积 | 队列长度限制 + 滑动窗口 |
| 重复消息 | 消息 ID 去重集合 |
| 孤儿进程 | Hub 客户端在 CC 主进程内，CC 退出自然终止 |
