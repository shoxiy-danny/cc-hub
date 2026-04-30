/**
 * CC Hub 客户端
 *
 * 供 CC 实例连接 Hub，实现多实例通讯
 * 不独立起进程，作为 CC 主进程的异步模块运行
 */

import { randomUUID } from 'crypto'

// ==================== 类型定义 ====================

interface Message {
  type: 'message' | 'command' | 'ack'
  id?: string
  from?: string
  to?: string
  content?: string
  status?: string
  timestamp?: number
  replyMode?: 'none' | 'confirm' | 'result' | 'critical'
  broadcastMode?: 'inform' | 'require_reply'
}

interface Ack {
  type: 'ack'
  id?: string
  from?: string
  status: string
  content?: string
}

// ==================== HubClient 类 ====================

export class HubClient {
  private ws: WebSocket | null = null
  private id: string = ''
  private hubUrl: string = ''
  private pendingAcks = new Map<string, (ack: Ack) => void>()
  private reconnectTimer: Timer | null = null
  private isConnected = false

  constructor(options: { id: string; hubUrl: string }) {
    this.id = options.id
    this.hubUrl = options.hubUrl
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.hubUrl)

        this.ws.addEventListener('open', () => {
          console.log(`[hub-client] 连接成功: ${this.id}`)
          this.isConnected = true
          this.register()
          resolve()
        })

        this.ws.addEventListener('message', (event) => {
          this.onMessage(event.data)
        })

        this.ws.addEventListener('close', () => {
          console.log(`[hub-client] 连接关闭: ${this.id}`)
          this.isConnected = false
          this.scheduleReconnect()
        })

        this.ws.addEventListener('error', (err) => {
          console.error(`[hub-client] 错误: ${err}`)
          if (!this.isConnected) reject(err)
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  private register(): void {
    this.send({ type: 'register', id: this.id })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    console.log(`[hub-client] 5秒后尝试重连...`)
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this.connect()
      } catch {
        // 重连失败，等待下一次
      }
    }, 5000)
  }

  send(msg: Partial<Message>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('[hub-client] 未连接，WebSocket 已断开')
    }

    const fullMsg = {
      id: msg.id || randomUUID(),
      from: this.id,
      timestamp: Date.now(),
      ...msg
    }

    this.ws.send(JSON.stringify(fullMsg))
  }

  async sendAndWait(msg: Partial<Message>, timeoutMs = 10000): Promise<Ack> {
    const id = msg.id || randomUUID()

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAcks.delete(id)
        reject(new Error('timeout'))
      }, timeoutMs)

      this.pendingAcks.set(id, (ack) => {
        clearTimeout(timeout)
        resolve(ack)
      })

      this.send({ ...msg, id })
    })
  }

  private onMessage(data: string): void {
    let msg: Ack | Message
    try {
      msg = JSON.parse(data)
    } catch {
      console.error(`[hub-client] 解析失败: ${data}`)
      return
    }

    if (msg.type === 'ack') {
      // 唤醒等待的 Promise
      if (msg.id) {
        const resolver = this.pendingAcks.get(msg.id)
        if (resolver) {
          resolver(msg as Ack)
          this.pendingAcks.delete(msg.id)
        }
      }
    } else if (msg.type === 'message' || msg.type === 'new_message') {
      // type: 'new_message' also goes through injectText since it's a broadcast notification
      this.injectText(msg.content || '', msg.from, msg.replyMode)
    } else if (msg.type === 'command') {
      this.injectCommand(msg.content || '', msg.from)
    }
  }

  // 注入普通文本到本地 CC
  private injectText(content: string, from?: string, replyMode?: string): void {
    // 存储发送者 ID，供 CC 回复时使用
    if (from) {
      globalThis.__hubLastMessageFrom = from
    }
    if (typeof globalThis.__hubClientInject === 'function') {
      globalThis.__hubClientInject(content, true, from, replyMode)  // skipSlash=true
    } else {
      console.warn(`[hub-client] 未设置注入函数，消息丢失: ${content.slice(0, 50)}...`)
    }
  }

  // 注入 slash 命令到本地 CC
  private injectCommand(content: string, from?: string): void {
    if (from) {
      globalThis.__hubLastMessageFrom = from
    }
    if (typeof globalThis.__hubClientInject === 'function') {
      globalThis.__hubClientInject(content, false, from)  // skipSlash=false
    } else {
      console.warn(`[hub-client] 未设置注入函数，命令丢失: ${content}`)
    }
  }

  // 发送文本消息
  sendMessage(to: string, content: string): void {
    this.send({ type: 'message', to, content })
  }

  // 发送 slash 命令
  sendCommand(to: string, content: string): void {
    this.send({ type: 'command', to, content })
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.isConnected = false
  }

  get connected(): boolean {
    return this.isConnected
  }
}

// ==================== 便捷函数 ====================

let globalClient: HubClient | null = null

export async function initHubClient(id: string, hubUrl: string): Promise<HubClient> {
  if (globalClient) {
    globalClient.disconnect()
  }

  globalClient = new HubClient({ id, hubUrl })
  await globalClient.connect()

  // CC 退出时自动断开
  process.on('exit', () => globalClient?.disconnect())

  return globalClient
}

export function getGlobalHubClient(): HubClient | null {
  return globalClient
}
