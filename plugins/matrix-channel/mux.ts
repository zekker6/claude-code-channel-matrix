import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createConnection, createServer, type Socket, type Server as NetServer } from 'node:net'
import type { TextEvent, ImageEvent, SyncEvent } from './server'

// ── Sync Token Persistence ────────────────────────────

const SYNC_TOKEN_FILE = 'sync-token'

export function loadSyncToken(channelsDir: string): string | null {
  const filePath = join(channelsDir, SYNC_TOKEN_FILE)
  if (!existsSync(filePath)) return null
  try {
    const token = readFileSync(filePath, 'utf-8').trim()
    return token || null
  } catch {
    return null
  }
}

export function saveSyncToken(channelsDir: string, token: string): void {
  mkdirSync(channelsDir, { recursive: true })
  writeFileSync(join(channelsDir, SYNC_TOKEN_FILE), token)
}

// ── File Lock via libc flock(2) ───────────────────────

import { dlopen, FFIType } from 'bun:ffi'

const LOCK_FILE = 'mux.lock'
export const SOCKET_FILE = 'mux.sock'

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

const libc = dlopen('libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})

export interface LockHandle {
  release: () => void
}

export function tryAcquireLock(channelsDir: string): LockHandle | null {
  const lockPath = join(channelsDir, LOCK_FILE)
  mkdirSync(channelsDir, { recursive: true })

  let fd: number
  try {
    fd = openSync(lockPath, 'w')
  } catch {
    return null
  }

  const result = libc.symbols.flock(fd, LOCK_EX | LOCK_NB)
  if (result !== 0) {
    closeSync(fd)
    return null
  }

  return {
    release: () => {
      try { libc.symbols.flock(fd, LOCK_UN) } catch {}
      try { closeSync(fd) } catch {}
    },
  }
}

// ── Wire Protocol Types ────────────────────────────────

export interface WireTextFrame {
  v: 1
  type: 'text'
  roomId: string
  roomName: string
  sender: string
  eventId: string
  threadRootId: string | null
  body: string
}

export interface WireImageFrame {
  v: 1
  type: 'image'
  roomId: string
  roomName: string
  sender: string
  eventId: string
  threadRootId: string | null
  body: string
  mxcUrl: string
  mimeType: string
  size: number | null
  filename: string | null
}

export interface WireHeartbeatFrame {
  v: 1
  type: 'heartbeat'
  ts: number
}

export type WireFrame = WireTextFrame | WireImageFrame | WireHeartbeatFrame

// ── Conversion ─────────────────────────────────────────

export function eventToFrame(event: SyncEvent): WireFrame {
  if (event.type === 'text') {
    return {
      v: 1,
      type: 'text',
      roomId: event.roomId,
      roomName: event.roomName,
      sender: event.sender,
      eventId: event.eventId,
      threadRootId: event.threadRootId,
      body: event.body,
    }
  }
  return {
    v: 1,
    type: 'image',
    roomId: event.roomId,
    roomName: event.roomName,
    sender: event.sender,
    eventId: event.eventId,
    threadRootId: event.threadRootId,
    body: event.body,
    mxcUrl: event.mxcUrl,
    mimeType: event.mimeType,
    size: event.size,
    filename: event.filename,
  }
}

export function frameToEvent(frame: WireTextFrame | WireImageFrame): SyncEvent {
  if (frame.type === 'text') {
    return {
      type: 'text',
      roomId: frame.roomId,
      roomName: frame.roomName,
      sender: frame.sender,
      eventId: frame.eventId,
      threadRootId: frame.threadRootId,
      body: frame.body,
    }
  }
  return {
    type: 'image',
    roomId: frame.roomId,
    roomName: frame.roomName,
    sender: frame.sender,
    eventId: frame.eventId,
    threadRootId: frame.threadRootId,
    body: frame.body,
    mxcUrl: frame.mxcUrl,
    mimeType: frame.mimeType,
    size: frame.size,
    filename: frame.filename,
  }
}

// ── Serialization ──────────────────────────────────────

export function serializeFrame(frame: WireFrame): string {
  return JSON.stringify(frame)
}

export function deserializeFrame(line: string): WireFrame | null {
  try {
    const obj = JSON.parse(line)
    if (obj.v !== 1) return null
    return obj as WireFrame
  } catch {
    return null
  }
}

// ── Multiplexer Socket Server ─────────────────────────

const HEARTBEAT_INTERVAL_MS = 60_000

export class MuxServer {
  private channelsDir: string
  private server: NetServer | null = null
  private clients = new Set<Socket>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(channelsDir: string) {
    this.channelsDir = channelsDir
  }

  get socketPath(): string {
    return join(this.channelsDir, SOCKET_FILE)
  }

  /** Returns false if socket path exceeds Unix domain socket limit (~107 bytes on Linux). */
  static validateSocketPath(channelsDir: string): boolean {
    const sockPath = join(channelsDir, SOCKET_FILE)
    if (sockPath.length > 107) {
      console.error(`Socket path too long (${sockPath.length} bytes, max 107): ${sockPath}`)
      console.error('Falling back to direct sync mode. Set CLAUDE_CONFIG_DIR to a shorter path.')
      return false
    }
    return true
  }

  async start(): Promise<void> {
    try { unlinkSync(this.socketPath) } catch {}

    this.server = createServer((socket) => {
      this.clients.add(socket)
      socket.on('close', () => this.clients.delete(socket))
      socket.on('error', () => this.clients.delete(socket))
    })

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.socketPath, () => resolve())
      this.server!.on('error', reject)
    })

    this.heartbeatTimer = setInterval(() => {
      this.broadcast({ v: 1, type: 'heartbeat', ts: Date.now() })
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref()
  }

  broadcast(frame: WireFrame): void {
    const line = serializeFrame(frame) + '\n'
    for (const client of this.clients) {
      try {
        client.write(line)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    for (const client of this.clients) {
      client.destroy()
    }
    this.clients.clear()
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
      this.server = null
    }
    try { unlinkSync(this.socketPath) } catch {}
  }
}

// ── Multiplexer Socket Client ─────────────────────────

const HEARTBEAT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RETRIES = 5
const DEFAULT_RETRY_DELAY_MS = 500

export interface MuxClientOptions {
  maxRetries?: number
  retryDelayMs?: number
  heartbeatTimeoutMs?: number
}

export class MuxClient {
  private channelsDir: string
  private socket: Socket | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private buffer = ''
  private opts: Required<MuxClientOptions>

  onFrame: ((frame: WireFrame) => void) | null = null
  onDisconnect: (() => void) | null = null

  constructor(channelsDir: string, opts: MuxClientOptions = {}) {
    this.channelsDir = channelsDir
    this.opts = {
      maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryDelayMs: opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS,
    }
  }

  get socketPath(): string {
    return join(this.channelsDir, SOCKET_FILE)
  }

  async connect(): Promise<void> {
    for (let attempt = 0; attempt < this.opts.maxRetries; attempt++) {
      try {
        await this.tryConnect()
        return
      } catch {
        if (attempt < this.opts.maxRetries - 1) {
          await new Promise((r) => setTimeout(r, this.opts.retryDelayMs))
        }
      }
    }
    throw new Error(`Failed to connect to multiplexer after ${this.opts.maxRetries} attempts`)
  }

  private tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      socket.on('connect', () => {
        this.socket = socket
        this.resetHeartbeatTimeout()
        this.setupDataHandler(socket)
        resolve()
      })
      socket.on('error', (err) => {
        if (!this.socket) {
          reject(err)
        } else {
          this.handleDisconnect()
        }
      })
      socket.on('close', () => {
        if (this.socket) this.handleDisconnect()
      })
    })
  }

  private setupDataHandler(socket: Socket): void {
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString()
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop()!

      for (const line of lines) {
        if (!line) continue
        this.resetHeartbeatTimeout()
        const frame = deserializeFrame(line)
        if (frame && frame.type !== 'heartbeat' && this.onFrame) {
          this.onFrame(frame)
        }
      }
    })
  }

  private resetHeartbeatTimeout(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = setTimeout(() => {
      console.error('Multiplexer heartbeat timeout — initiating takeover')
      this.handleDisconnect()
    }, this.opts.heartbeatTimeoutMs)
    this.heartbeatTimer.unref()
  }

  private handleDisconnect(): void {
    this.disconnect()
    if (this.onDisconnect) this.onDisconnect()
  }

  disconnect(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this.buffer = ''
  }
}
