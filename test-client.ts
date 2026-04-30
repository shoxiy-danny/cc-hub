/**
 * Hub 简单测试客户端
 * 测试：连接、注册、发送消息
 */

import { randomUUID } from 'crypto'

const HUB_URL = 'ws://localhost:8080'

async function test() {
  // 连接 haha
  const ws1 = new WebSocket(HUB_URL)
  await new Promise<void>((resolve, reject) => {
    ws1.onopen = () => resolve()
    ws1.onerror = (e) => reject(e)
  })
  console.log('[haha] 连接成功')

  // 注册
  ws1.send(JSON.stringify({ type: 'register', id: 'haha' }))
  await waitForAck(ws1)
  console.log('[haha] 注册成功')

  // 连接 mirror
  const ws2 = new WebSocket(HUB_URL)
  await new Promise<void>((resolve, reject) => {
    ws2.onopen = () => resolve()
    ws2.onerror = (e) => reject(e)
  })
  console.log('[mirror] 连接成功')

  // 注册
  ws2.send(JSON.stringify({ type: 'register', id: 'mirror' }))
  await waitForAck(ws2)
  console.log('[mirror] 注册成功')

  // haha 发送文本消息给 mirror
  console.log('\n[haha] 发送文本消息给 mirror...')
  ws1.send(JSON.stringify({
    type: 'message',
    id: randomUUID(),
    from: 'haha',
    to: 'mirror',
    content: '你好 mirror!'
  }))

  // 等待 mirror 收到
  const msg = await waitForMessage(ws2)
  console.log('[mirror] 收到:', msg.content)

  // 等待 haha 收到 ack
  await waitForAck(ws1)
  console.log('[haha] 收到 ACK')

  // mirror 回复 haha
  console.log('\n[mirror] 回复 haha...')
  ws2.send(JSON.stringify({
    type: 'message',
    id: randomUUID(),
    from: 'mirror',
    to: 'haha',
    content: '收到，你好 haha!'
  }))

  // 等待 haha 收到
  const reply = await waitForMessage(ws1)
  console.log('[haha] 收到回复:', reply.content)

  // haha 发送 slash 命令
  console.log('\n[haha] 发送 slash 命令 /clear 给 mirror...')
  ws1.send(JSON.stringify({
    type: 'command',
    id: randomUUID(),
    from: 'haha',
    to: 'mirror',
    content: '/clear'
  }))

  // 等待 mirror 收到
  const cmd = await waitForMessage(ws2)
  console.log('[mirror] 收到命令:', cmd.content)
  console.log('(类型是 command，不走 slash 命令解析)')

  // 测试广播
  console.log('\n[haha] 广播消息...')
  ws1.send(JSON.stringify({
    type: 'message',
    id: randomUUID(),
    from: 'haha',
    to: 'all',
    content: '大家好！'
  }))

  // 等待 mirror 收到广播
  const broadcast = await waitForMessage(ws2)
  console.log('[mirror] 收到广播:', broadcast.content)

  // 测试 /clients 接口
  console.log('\n测试 HTTP 接口...')
  const clientsResp = await fetch('http://localhost:8080/clients')
  const clients = await clientsResp.json()
  console.log('已连接客户端:', clients.clients.map((c: { id: string }) => c.id))

  // 测试 /logs 接口
  const logsResp = await fetch('http://localhost:8080/logs')
  const logs = await logsResp.json()
  console.log(`日志条数: ${logs.count}`)

  console.log('\n✅ 所有测试通过!')

  ws1.close()
  ws2.close()
}

function waitForAck(ws: WebSocket): Promise<Ack> {
  return new Promise((resolve) => {
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.type === 'ack') {
        resolve(msg as Ack)
      }
    }
  })
}

function waitForMessage(ws: WebSocket): Promise<{ content: string; type: string }> {
  return new Promise((resolve) => {
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.type === 'message' || msg.type === 'command') {
        resolve(msg)
      }
    }
  })
}

interface Ack {
  type: 'ack'
  id?: string
  from?: string
  status: string
  content?: string
}

test().catch(console.error)
