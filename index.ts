/**
 * CC Hub - 多 Claude Code 实例通讯中转服务器
 *
 * 运行: bun run index.ts
 * 环境变量:
 *   CC_HUB_PORT=8080
 *   CC_HUB_LOG_FILE=hub.log
 *   CC_HUB_DB=hub.db
 */

import { randomUUID } from 'crypto'
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// ==================== TTS 配置 ====================

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || ''
console.log('[hub] MINIMAX_API_KEY set:', MINIMAX_API_KEY ? 'yes (length=' + MINIMAX_API_KEY.length + ')' : 'NO')
const TTS_WS_URL = 'wss://api.minimaxi.com/ws/v1/t2a_v2'
const TTS_MODEL = 'speech-2.8-hd'
const AUDIO_DIR = join(process.cwd(), 'audio')

// TTS 开关状态（默认关闭）
const ttsEnabled: Record<string, boolean> = {
  haha: false,
  mirror: false,
  qcc: false
}

// 长消息提示语
const TTS_LONG_MSG: Record<string, string> = {
  haha: 'haha有话跟你说',
  mirror: 'mirror发来消息',
  qcc: 'qcc在等你'
}

// 音色配置
const TTS_VOICE: Record<string, string> = {
  haha: 'female-tianmei',
  mirror: 'danya_xuejie',
  qcc: 'female-shaonv'
}

// ==================== TTS WebSocket 代理 ====================

async function handleTtsRequest(ws: WebSocket, cc: string, text: string) {
  // 超过100字：用本地预录音频，不调API
  if (text.length > 100) {
    const audioFile = join(AUDIO_DIR, `${cc}.txt`)
    if (existsSync(audioFile)) {
      const audioHex = readFileSync(audioFile, 'utf8')
      ws.send(JSON.stringify({ type: 'tts_audio', audio: audioHex, cc }))
      ws.send(JSON.stringify({ type: 'tts_done', cc }))
      console.log(`[hub] TTS local: cc=${cc}, origTextLen=${text.length}, using local audio (no API call)`)
    } else {
      console.log(`[hub] TTS local: file not found for ${cc}`)
    }
    return
  }

  if (!MINIMAX_API_KEY) {
    ws.send(JSON.stringify({ type: 'tts_error', content: 'TTS_API_KEY_NOT_SET' }))
    return
  }

  const voiceId = TTS_VOICE[cc] || 'female-tianmei'
  const finalText = text
  console.log(`[hub] TTS API: cc=${cc}, voice=${voiceId}, text="${finalText}"`)

  try {
    // 建立到 MiniMax 的 WebSocket 连接
    const ttsWs = await createTtsWs(voiceId, (audioHex, isFinal) => {
      if (audioHex) {
        ws.send(JSON.stringify({ type: 'tts_audio', audio: audioHex, cc }))
      }
      if (isFinal) {
        ws.send(JSON.stringify({ type: 'tts_done', cc }))
      }
    })

    if (!ttsWs) {
      console.log('[hub] TTS: createTtsWs returned null')
      ws.send(JSON.stringify({ type: 'tts_error', content: 'TTS_CONNECTION_FAILED' }))
      return
    }

    console.log(`[hub] TTS API connected, sending text: "${finalText.substring(0, 50)}..."`)
    // 发送文本
    ttsWs.send(JSON.stringify({ event: 'task_continue', text: finalText }))

  } catch (err) {
    console.error('[hub] TTS error:', err)
    ws.send(JSON.stringify({ type: 'tts_error', content: 'TTS_ERROR' }))
  }
}

function createTtsWs(voiceId: string, onMessage: (audio: string | null, isFinal: boolean) => void): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    try {
      const ttsWs = new WebSocket(TTS_WS_URL, {
        headers: {
          'Authorization': `Bearer ${MINIMAX_API_KEY}`
        }
      })

      let connected = false

      ttsWs.addEventListener('open', () => {
        // 发送开始请求
        ttsWs.send(JSON.stringify({
          event: 'task_start',
          model: TTS_MODEL,
          voice_setting: {
            voice_id: voiceId,
            speed: 1,
            vol: 1,
            pitch: 0,
            english_normalization: false
          },
          audio_setting: {
            sample_rate: 32000,
            bitrate: 128000,
            format: 'mp3',
            channel: 1
          }
        }))
      })

      ttsWs.addEventListener('message', (evt) => {
        try {
          const data = JSON.parse(evt.data)

          if (!connected && data.event === 'connected_success') {
            connected = true
            resolve(ttsWs)
            return
          }

          if (data.event === 'task_started') {
            // 开始完成，等待文本
            return
          }

          if (data.data?.audio) {
            onMessage(data.data.audio, false)
          }

          if (data.is_final) {
            onMessage(null, true)
            ttsWs.close()
          }
        } catch {
          // ignore parse errors
        }
      })

      ttsWs.addEventListener('error', (err) => {
        console.log('[hub] TTS WebSocket error:', err)
        connected = true
        resolve(null)
      })

      ttsWs.addEventListener('close', () => {
        if (!connected) {
          connected = true
          resolve(null)
        }
      })

      // 超时处理
      setTimeout(() => {
        if (!connected) {
          connected = true
          ttsWs.close()
          resolve(null)
        }
      }, 5000)

    } catch {
      resolve(null)
    }
  })
}

// ==================== 类型定义 ====================

interface Client {
  ws: WebSocket
  id: string
  lastMessageTime: number
  messageCount: number   // 滑动窗口计数
  windowStart: number    // 滑动窗口起始时间
}

interface LogEntry {
  id: string
  time: string
  from: string
  to: string
  type: 'message' | 'command' | 'ack' | 'register'
  preview: string
  status: 'ok' | 'rate_limited' | 'not_found' | 'error'
}

interface HubMessage {
  type: 'message' | 'command' | 'ack' | 'register' | 'tts_switch' | 'tts_request'
  id?: string
  from?: string
  to?: string
  content?: string
  status?: string
  timestamp?: number
  cc?: string
  enabled?: boolean
  text?: string
  // CC 回复模式：ping(连通性测试), notify(通知), async(异步), sync(同步)
  replyMode?: 'ping' | 'notify' | 'async' | 'sync'
  // 广播模式：inform(通知，默认), require_reply(需要确认)
  broadcastMode?: 'inform' | 'require_reply'
}

interface DbMessage {
  id: string
  time: string
  from: string
  to: string
  type: string
  content: string
  status: string
}

// ==================== 常量配置 ====================

const PORT = parseInt(process.env.CC_HUB_PORT || '8080')
const SEND_INTERVAL_MS = 1000       // 发送间隔
const RECEIVE_WINDOW_MS = 10000    // 接收滑动窗口
const RECEIVE_MAX = 5              // 窗口内最多5条
const MAX_MESSAGE_SIZE = 1024 * 1024  // 1MB
const MAX_LOGS = 5000
const MAX_QUEUE = 1000
const DEFAULT_LOG_FILE = process.env.CC_HUB_LOG_FILE || 'hub.log'
const DEFAULT_DB_FILE = process.env.CC_HUB_DB || 'hub.db'

// ==================== SQLite 数据库 ====================

const db = new Database(DEFAULT_DB_FILE)

// 初始化消息表
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    time TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT,
    status TEXT NOT NULL
  )
`)

// 初始化 ws_clients 表（用于 WebSocket 实时推送订阅）
db.exec(`
  CREATE TABLE IF NOT EXISTS ws_subscriptions (
    client_id TEXT PRIMARY KEY,
    last_event_id TEXT
  )
`)

// ==================== 消息存储 ====================

const MAX_MESSAGES = 500 // 最多保留消息条数

// 清理旧消息，保留最近 N 条
function cleanupOldMessages() {
  try {
    const count = db.query('SELECT COUNT(*) FROM messages').get() as { 'COUNT(*)': number }
    if (count['COUNT(*)'] <= MAX_MESSAGES) return

    const deleteCount = count['COUNT(*)'] - MAX_MESSAGES
    db.exec(`
      DELETE FROM messages WHERE id IN (
        SELECT id FROM messages ORDER BY time ASC LIMIT ${deleteCount}
      )
    `)
    console.log(`[hub] 清理旧消息，删除 ${deleteCount} 条，剩余 ${MAX_MESSAGES} 条`)
  } catch (err) {
    console.error('[hub] 清理消息失败:', err)
  }
}

// 启动时清理一次
cleanupOldMessages()

function saveMessageToDb(msg: LogEntry & { content: string }) {
  try {
    db.prepare(
      'INSERT OR REPLACE INTO messages (id, time, "from", "to", type, content, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(msg.id, msg.time, msg.from, msg.to, msg.type, msg.content, msg.status)
  } catch (err) {
    console.error('[hub] Failed to save message to DB:', err)
  }
}

function getMessagesFromDb(opts: {
  from?: string
  to?: string
  type?: string
  limit?: number
  after?: string
}): DbMessage[] {
  let sql = 'SELECT * FROM messages WHERE 1=1'
  const params: (string | number)[] = []

  if (opts.from) {
    sql += ' AND "from" = ?'
    params.push(opts.from)
  }
  if (opts.to) {
    sql += ' AND "to" = ?'
    params.push(opts.to)
  }
  if (opts.type) {
    sql += ' AND type = ?'
    params.push(opts.type)
  }
  if (opts.after) {
    sql += ' AND time > ?'
    params.push(opts.after)
  }

  sql += ' ORDER BY time DESC'

  if (opts.limit) {
    sql += ' LIMIT ?'
    params.push(opts.limit)
  }

  try {
    return db.prepare(sql).all(...params) as DbMessage[]
  } catch (err) {
    console.error('[hub] Failed to get messages from DB:', err)
    return []
  }
}

// ==================== WebSocket 实时推送 ====================

function broadcastNewMessage(msg: HubMessage & { dbId: string }) {
  const broadcastMsg = {
    type: 'new_message',
    ...msg
  }
  for (const [, client] of clients) {
    try {
      client.ws.send(JSON.stringify(broadcastMsg))
    } catch {
      // ignore
    }
  }
}

// ==================== 状态 ====================

const clients = new Map<string, Client>()
const recentMessageIds = new Set<string>()
const logs: LogEntry[] = []

// ==================== 日志 ====================

function addLog(entry: Omit<LogEntry, 'id' | 'time'>) {
  const log: LogEntry = {
    id: randomUUID(),
    time: new Date().toISOString(),
    ...entry
  }
  logs.push(log)
  if (logs.length > MAX_LOGS) logs.shift()

  // 默认写入文件
  const line = JSON.stringify(log) + '\n'
  Bun.write(DEFAULT_LOG_FILE, line, { flag: 'a' })
}

// ==================== 限速检查 ====================

function checkRateLimit(client: Client, msgType: string): { allowed: boolean; reason?: string } {
  // ack 不限速
  if (msgType === 'ack') {
    return { allowed: true }
  }

  const now = Date.now()

  // 发送间隔检查
  if (now - client.lastMessageTime < SEND_INTERVAL_MS) {
    return { allowed: false, reason: 'rate_limited: send interval' }
  }

  // 接收滑动窗口检查
  if (now - client.windowStart > RECEIVE_WINDOW_MS) {
    client.windowStart = now
    client.messageCount = 0
  }

  if (client.messageCount >= RECEIVE_MAX) {
    return { allowed: false, reason: 'rate_limited: receive window full' }
  }

  client.messageCount++
  client.lastMessageTime = now
  return { allowed: true }
}

// ==================== 消息路由 ====================

function routeMessage(senderId: string, msg: HubMessage): void {
  const { type, id, from, to, content } = msg
  console.log(`[hub] routeMessage: sender=${senderId}, to="${to}", type=${type}`)

  if (!to) return

  // 防止自消息循环：检查 senderId 和 to 是否是同一个 WebSocket 连接
  // 如果是自消息（发给自己的连接），不路由到其他人，但仍发送 ACK
  const senderClient = clients.get(senderId)
  const targetClient = to === 'all' || to === 'broadcast' ? null : clients.get(to)
  const isSelfMessage = targetClient && senderClient && senderClient.ws === targetClient.ws

  // 生成唯一 ID 并存储到数据库
  const dbId = id || randomUUID()
  const time = new Date().toISOString()

  if (to === 'all' || to === 'broadcast') {
    console.log(`[hub] broadcast detected, broadcastMode=${msg.broadcastMode}`)
    // 广播模式
    if (msg.broadcastMode === 'require_reply') {
      // 关键广播：发给所有人，type 改为 'new_message' 触发 CC 处理
      for (const [clientId, client] of clients) {
        if (clientId !== senderId) {
          client.ws.send(JSON.stringify({ ...msg, type: 'new_message' }))
        }
      }
      const logEntry = { from: from || senderId, to: 'all', type: 'message', preview: content?.slice(0, 100) || '', status: 'ok' }
      addLog(logEntry)
      const dbLog = { ...logEntry, id: dbId, time, content: content || '' }
      saveMessageToDb(dbLog)
    } else {
      // 普通广播（broadcastMode='inform' 或未设置）：只发 message，不触发 new_message
      // CC 收到后只记录日志，不注入 LLM
      for (const [clientId, client] of clients) {
        if (clientId !== senderId) {
          client.ws.send(JSON.stringify(msg))
        }
      }
      const logEntry = { from: from || senderId, to: 'all', type, preview: content?.slice(0, 100) || '', status: 'ok' }
      addLog(logEntry)
      const dbLog = { ...logEntry, id: dbId, time, content: content || '' }
      saveMessageToDb(dbLog)
    }
  } else {
    // 点对点发送
    const target = clients.get(to)
    if (!target) {
      const logEntry = { from: from || senderId, to, type, preview: content?.slice(0, 100) || '', status: 'not_found' }
      addLog(logEntry)
      const dbLog = { ...logEntry, id: dbId, time, content: content || '' }
      saveMessageToDb(dbLog)
      sendToClient(senderId, { type: 'ack', id, from: to, status: 'offline' })
      return
    }

    target.ws.send(JSON.stringify(msg))
    const logEntry = { from: from || senderId, to, type, preview: content?.slice(0, 100) || '', status: 'ok' }
    addLog(logEntry)

    // 存储到数据库
    const dbLog = { ...logEntry, id: dbId, time, content: content || '' }
    saveMessageToDb(dbLog)

    // 发送 ACK 给发送方
    sendToClient(senderId, { type: 'ack', id, from: to, status: 'received' })
  }
}

function sendToClient(clientId: string, msg: object): void {
  const client = clients.get(clientId)
  if (client) {
    client.ws.send(JSON.stringify(msg))
  }
}

// ==================== WebSocket 服务器 ====================

const server = Bun.serve({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url)

    // CORS 预检
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      })
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
    }

    // HTTP 接口：消息查询（从 SQLite）
    if (url.pathname === '/messages') {
      const from = url.searchParams.get('from') || undefined
      const to = url.searchParams.get('to') || undefined
      const type = url.searchParams.get('type') || undefined
      const limit = parseInt(url.searchParams.get('limit') || '100')
      const after = url.searchParams.get('after') || undefined

      const messages = getMessagesFromDb({ from, to, type, limit, after })

      return Response.json({
        count: messages.length,
        messages
      }, { headers: corsHeaders })
    }

    // HTTP 接口：日志查看（内存）
    if (url.pathname === '/logs' || url.pathname.startsWith('/logs/')) {
      const from = url.searchParams.get('from')
      const to = url.searchParams.get('to')
      const type = url.searchParams.get('type')
      const limit = parseInt(url.searchParams.get('limit') || '100')

      let filtered = logs.slice(-MAX_LOGS)

      if (from) filtered = filtered.filter(l => l.from === from)
      if (to) filtered = filtered.filter(l => l.to === to)
      if (type) filtered = filtered.filter(l => l.type === type)

      filtered = filtered.slice(-limit)

      return Response.json({
        count: filtered.length,
        logs: filtered
      }, { headers: corsHeaders })
    }

    // HTTP 接口：客户端列表
    if (url.pathname === '/clients') {
      const clientList = Array.from(clients.entries()).map(([id, c]) => ({
        id,
        lastMessageTime: new Date(c.lastMessageTime).toISOString()
      }))
      return Response.json({ clients: clientList, total: clientList.length }, { headers: corsHeaders })
    }

    // HTTP 接口：健康检查
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', clients: clients.size }, { headers: corsHeaders })
    }

    // HTTP 接口：TTS 状态（调试用）
    if (url.pathname === '/tts-status') {
      return Response.json({ ttsEnabled }, { headers: corsHeaders })
    }

    // WebSocket 升级
    if (server.upgrade(req)) return
    return new Response('WebSocket server', { status: 426 })
  },

  websocket: {
    open(ws) {
      ws.id = randomUUID()
      console.log(`[hub] 新连接 ${ws.id} from ${ws.remoteAddress}`)
    },

    message(ws, message) {
      const raw = message.toString()
      let parsed: any
      try {
        parsed = JSON.parse(raw)
      } catch {
        ws.send(JSON.stringify({ type: 'error', content: 'invalid_json' }))
        return
      }
      // 不打印 audio 字段，tts_audio 的 hex 数据太大会损坏日志
      if (parsed.type === 'tts_audio') {
        console.log(`[hub] RAW WS ${ws.id}: tts_audio cc=${parsed.cc}, audioLen=${parsed.audio?.length || 0}`)
      } else {
        console.log(`[hub] RAW WS ${ws.id}:`, raw.substring(0, 300))
      }
      let msg: HubMessage = parsed

      const logMsg = { ...msg }
      if ((logMsg as any).audio) (logMsg as any).audio = `[hex ${(logMsg as any).audio.length} chars]`
      console.log(`[hub] WS ${ws.id} message:`, logMsg.type, logMsg)

      // 查找或创建客户端
      let client = Array.from(clients.entries()).find(([, c]) => c.ws === ws)
      const clientId = client?.[0]

      // 注册
      if (msg.type === 'register' && msg.id) {
        if (clientId) {
          clients.delete(clientId)
        }
        const newClient: Client = {
          ws,
          id: msg.id,
          lastMessageTime: 0,
          messageCount: 0,
          windowStart: Date.now(),
        }
        clients.set(msg.id, newClient)
        console.log(`[hub] 注册: ${msg.id} (ws ${ws.id}), 当前在线: ${clients.size}`)
        ws.send(JSON.stringify({ type: 'ack', id: msg.id, from: 'hub', status: 'received' }))
        return
      }

      if (!clientId) {
        ws.send(JSON.stringify({ type: 'error', content: 'not_registered' }))
        return
      }

      const clientInfo = clients.get(clientId)!

      // TTS 开关 - 不受 rate limit 限制
      if (msg.type === 'tts_switch' && msg.cc) {
        console.log('[hub] 收到 tts_switch:', msg)
        const cc = msg.cc as string
        if (cc in ttsEnabled) {
          ttsEnabled[cc] = !!msg.enabled
          console.log(`[hub] TTS 开关: ${cc} = ${ttsEnabled[cc]}`)
          ws.send(JSON.stringify({ type: 'tts_switch_ack', cc, enabled: ttsEnabled[cc] }))
        }
        return
      }

      // TTS 请求 - 不受 rate limit 限制
      if (msg.type === 'tts_request' && msg.from && msg.text) {
        const cc = msg.from as string
        if (!ttsEnabled[cc]) {
          return
        }
        const text = msg.text as string
        // 超过50字用本地音频，不调API（MMX计费：1汉字=2字符，1汉字≈2个length）
        if (text.length > 50) {
          const audioFile = join(AUDIO_DIR, `${cc}.txt`)
          if (existsSync(audioFile)) {
            const audioHex = readFileSync(audioFile, 'utf8')
            ws.send(JSON.stringify({ type: 'tts_audio', audio: audioHex, cc }))
            ws.send(JSON.stringify({ type: 'tts_done', cc }))
            console.log(`[hub] TTS local: cc=${cc}, origTextLen=${text.length}, using local audio (no API call)`)
          } else {
            console.log(`[hub] TTS local: file not found for ${cc}`)
          }
        } else {
          handleTtsRequest(ws, cc, text)
        }
        return
      }

      // 内容大小检查
      const msgStr = message.toString()
      if (msgStr.length > MAX_QUEUE) {
        ws.send(JSON.stringify({ type: 'ack', id: msg.id, from: clientId, status: 'error', content: 'message_too_large' }))
        return
      }

      // 去重检查
      if (msg.id && recentMessageIds.has(msg.id)) {
        console.log(`[hub] 丢弃重复消息: ${msg.id}`)
        return
      }
      if (msg.id) {
        recentMessageIds.add(msg.id)
        if (recentMessageIds.size > 100) {
          const first = recentMessageIds.values().next().value
          recentMessageIds.delete(first)
        }
      }

      // 路由消息
      routeMessage(clientId, msg)
    },

    close(ws) {
      const client = Array.from(clients.entries()).find(([, c]) => c.ws === ws)
      if (client) {
        console.log(`[hub] 断开: ${client[0]}, 剩余: ${clients.size - 1}`)
        clients.delete(client[0])
      }
    }
  }
})

console.log(`[hub] CC Hub 启动，监听端口 ${PORT}`)
console.log(`[hub] HTTP 接口: http://localhost:${PORT}/logs`)
console.log(`[hub] HTTP 接口: http://localhost:${PORT}/messages`)
console.log(`[hub] WebSocket: ws://localhost:${PORT}`)
