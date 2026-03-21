import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { TextEvent, ImageEvent, SyncEvent } from './server'
import {
  eventToFrame,
  frameToEvent,
  serializeFrame,
  deserializeFrame,
  loadSyncToken,
  saveSyncToken,
  tryAcquireLock,
  MuxServer,
  MuxClient,
  SOCKET_FILE,
  type WireTextFrame,
  type WireImageFrame,
  type WireHeartbeatFrame,
  type WireFrame,
} from './mux'

const textEvent: TextEvent = {
  type: 'text',
  roomId: '!room:example.com',
  roomName: 'General',
  sender: '@alice:example.com',
  eventId: '$evt1:example.com',
  threadRootId: '$root:example.com',
  body: 'hello world',
}

const imageEvent: ImageEvent = {
  type: 'image',
  roomId: '!room:example.com',
  roomName: 'Photos',
  sender: '@bob:example.com',
  eventId: '$evt2:example.com',
  threadRootId: null,
  body: 'photo.png',
  mxcUrl: 'mxc://example.com/abc123',
  mimeType: 'image/png',
  size: 4096,
  filename: 'photo.png',
}

describe('text event frame round-trip', () => {
  test('serializes and deserializes back to original', () => {
    const frame = eventToFrame(textEvent)
    expect(frame.v).toBe(1)
    expect(frame.type).toBe('text')

    const line = serializeFrame(frame)
    expect(line).not.toContain('\n')

    const parsed = deserializeFrame(line)
    expect(parsed).not.toBeNull()
    expect(parsed!.type).toBe('text')

    const restored = frameToEvent(parsed as WireTextFrame)
    expect(restored).toEqual(textEvent)
  })
})

describe('image event frame round-trip', () => {
  test('serializes and deserializes back to original', () => {
    const frame = eventToFrame(imageEvent)
    expect(frame.v).toBe(1)
    expect(frame.type).toBe('image')

    const line = serializeFrame(frame)
    expect(line).not.toContain('\n')

    const parsed = deserializeFrame(line)
    expect(parsed).not.toBeNull()

    const imgFrame = parsed as WireImageFrame
    expect(imgFrame.mxcUrl).toBe('mxc://example.com/abc123')
    expect(imgFrame.size).toBe(4096)
    expect(imgFrame.filename).toBe('photo.png')

    const restored = frameToEvent(imgFrame)
    expect(restored).toEqual(imageEvent)
  })
})

describe('heartbeat frame round-trip', () => {
  test('serializes and deserializes back to original', () => {
    const hb: WireHeartbeatFrame = { v: 1, type: 'heartbeat', ts: 1700000000000 }
    const line = serializeFrame(hb)
    expect(line).not.toContain('\n')

    const parsed = deserializeFrame(line)
    expect(parsed).not.toBeNull()
    expect(parsed!.type).toBe('heartbeat')
    expect((parsed as WireHeartbeatFrame).ts).toBe(1700000000000)
  })
})

describe('deserializeFrame rejects invalid input', () => {
  test('returns null for unknown version', () => {
    const line = JSON.stringify({ v: 2, type: 'text', body: 'hi' })
    expect(deserializeFrame(line)).toBeNull()
  })

  test('returns null for malformed JSON', () => {
    expect(deserializeFrame('{not valid json')).toBeNull()
  })
})

describe('sync token persistence', () => {
  const tmpDir = '/tmp/mux-test-sync-token'

  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('returns null when file does not exist', () => {
    expect(loadSyncToken(tmpDir)).toBeNull()
  })

  test('saves and loads token', () => {
    saveSyncToken(tmpDir, 's_abc123')
    expect(loadSyncToken(tmpDir)).toBe('s_abc123')
  })

  test('overwrites previous token', () => {
    saveSyncToken(tmpDir, 's_first')
    saveSyncToken(tmpDir, 's_second')
    expect(loadSyncToken(tmpDir)).toBe('s_second')
  })
})

describe('tryAcquireLock', () => {
  const tmpDir = '/tmp/mux-test-lock'

  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('acquires lock when no contention', () => {
    const result = tryAcquireLock(tmpDir)
    expect(result).not.toBeNull()
    result!.release()
  })

  test('fails when lock already held', () => {
    const first = tryAcquireLock(tmpDir)
    expect(first).not.toBeNull()
    const second = tryAcquireLock(tmpDir)
    expect(second).toBeNull()
    first!.release()
  })

  test('succeeds after previous holder releases', () => {
    const first = tryAcquireLock(tmpDir)
    first!.release()
    const second = tryAcquireLock(tmpDir)
    expect(second).not.toBeNull()
    second!.release()
  })
})

describe('MuxServer', () => {
  const tmpDir = '/tmp/mux-test-server'

  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('broadcasts frames to connected clients', async () => {
    const server = new MuxServer(tmpDir)
    await server.start()

    const sockPath = join(tmpDir, 'mux.sock')
    const client = createConnection(sockPath)
    await new Promise<void>((resolve) => client.on('connect', resolve))

    const lines: string[] = []
    client.on('data', (chunk) => {
      lines.push(...chunk.toString().split('\n').filter(Boolean))
    })

    server.broadcast({
      v: 1, type: 'text', roomId: '!room:ex', roomName: 'Test',
      sender: '@u:ex', eventId: '$e1', threadRootId: null, body: 'hello',
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]).body).toBe('hello')

    client.destroy()
    await server.stop()
  })

  test('removes stale socket file on start', async () => {
    const sockPath = join(tmpDir, 'mux.sock')
    writeFileSync(sockPath, 'stale')

    const server = new MuxServer(tmpDir)
    await server.start()
    await server.stop()
  })

  test('validates socket path length — rejects long paths', () => {
    const longDir = '/tmp/' + 'a'.repeat(120)
    expect(MuxServer.validateSocketPath(longDir)).toBe(false)
  })

  test('validates socket path length — accepts short paths', () => {
    expect(MuxServer.validateSocketPath(tmpDir)).toBe(true)
  })
})

describe('MuxClient', () => {
  const tmpDir = '/tmp/mux-test-client'

  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('receives events from server', async () => {
    const server = new MuxServer(tmpDir)
    await server.start()

    const received: WireFrame[] = []
    const client = new MuxClient(tmpDir)
    client.onFrame = (frame) => received.push(frame)
    await client.connect()

    server.broadcast({
      v: 1, type: 'text', roomId: '!r:ex', roomName: 'T',
      sender: '@u:ex', eventId: '$e', threadRootId: null, body: 'test',
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(received.length).toBe(1)
    expect(received[0].type).toBe('text')

    client.disconnect()
    await server.stop()
  })

  test('filters out heartbeat frames from onFrame callback', async () => {
    const server = new MuxServer(tmpDir)
    await server.start()

    const received: WireFrame[] = []
    const client = new MuxClient(tmpDir)
    client.onFrame = (frame) => received.push(frame)
    await client.connect()

    server.broadcast({ v: 1, type: 'heartbeat', ts: Date.now() })
    await new Promise((r) => setTimeout(r, 50))
    expect(received.length).toBe(0)

    client.disconnect()
    await server.stop()
  })

  test('calls onDisconnect when server stops', async () => {
    const server = new MuxServer(tmpDir)
    await server.start()

    let disconnected = false
    const client = new MuxClient(tmpDir)
    client.onDisconnect = () => { disconnected = true }
    await client.connect()

    await server.stop()
    await new Promise((r) => setTimeout(r, 100))
    expect(disconnected).toBe(true)
    client.disconnect()
  })

  test('connect fails after max retries with no server', async () => {
    const client = new MuxClient(tmpDir, { maxRetries: 2, retryDelayMs: 50 })
    const result = await client.connect().catch(() => 'failed')
    expect(result).toBe('failed')
  })
})

describe('multiplexer lifecycle', () => {
  const tmpDir = '/tmp/mux-test-lifecycle'

  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('client takes over when server stops', async () => {
    // 1. Start multiplexer (lock + server)
    const lock1 = tryAcquireLock(tmpDir)
    expect(lock1).not.toBeNull()
    const server1 = new MuxServer(tmpDir)
    await server1.start()

    // 2. Start client
    const received: WireFrame[] = []
    let disconnectCount = 0
    const client = new MuxClient(tmpDir)
    client.onFrame = (f) => received.push(f)
    client.onDisconnect = () => { disconnectCount++ }
    await client.connect()

    // 3. Broadcast a message
    server1.broadcast({
      v: 1, type: 'text', roomId: '!r:ex', roomName: 'T',
      sender: '@u:ex', eventId: '$e1', threadRootId: null, body: 'msg1',
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(received.length).toBe(1)

    // 4. Stop multiplexer, release lock
    await server1.stop()
    lock1!.release()
    await new Promise((r) => setTimeout(r, 200))
    expect(disconnectCount).toBe(1)

    // 5. New instance can take over
    const lock2 = tryAcquireLock(tmpDir)
    expect(lock2).not.toBeNull()
    const server2 = new MuxServer(tmpDir)
    await server2.start()

    // 6. New client connects
    const client2 = new MuxClient(tmpDir)
    const received2: WireFrame[] = []
    client2.onFrame = (f) => received2.push(f)
    await client2.connect()

    server2.broadcast({
      v: 1, type: 'text', roomId: '!r:ex', roomName: 'T',
      sender: '@u:ex', eventId: '$e2', threadRootId: null, body: 'msg2',
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(received2.length).toBe(1)

    client2.disconnect()
    await server2.stop()
    lock2!.release()
  })

  test('sync token persists across takeover', () => {
    saveSyncToken(tmpDir, 's_token_abc')
    expect(loadSyncToken(tmpDir)).toBe('s_token_abc')
  })

  test('multiple clients receive same broadcast', async () => {
    const server = new MuxServer(tmpDir)
    await server.start()

    const received1: WireFrame[] = []
    const received2: WireFrame[] = []
    const client1 = new MuxClient(tmpDir)
    const client2 = new MuxClient(tmpDir)
    client1.onFrame = (f) => received1.push(f)
    client2.onFrame = (f) => received2.push(f)
    await client1.connect()
    await client2.connect()

    server.broadcast({
      v: 1, type: 'text', roomId: '!r:ex', roomName: 'T',
      sender: '@u:ex', eventId: '$e1', threadRootId: null, body: 'broadcast',
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(received1.length).toBe(1)
    expect(received2.length).toBe(1)

    client1.disconnect()
    client2.disconnect()
    await server.stop()
  })
})
