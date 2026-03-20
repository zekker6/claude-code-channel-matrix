#!/usr/bin/env bun

import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// ── Types ──────────────────────────────────────────────

export interface Config {
  homeserverUrl: string
  accessToken: string
  botUserId: string
  roomIds: string[] | null
}

export interface Access {
  allowedUsers: string[]
  ackReaction: string | null
  maxImageSize: number
}

// ── Config ─────────────────────────────────────────────

const CHANNELS_DIR = join(homedir(), '.claude', 'channels', 'matrix')
export const DEFAULT_MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10 MB

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. Run /matrix:configure to set up credentials, ` +
      `or set ${name} in ~/.claude/channels/matrix/.env`
    )
  }
  return value
}

export function loadConfig(envDir?: string): Config {
  // Load .env file if it exists (env vars take precedence)
  const envPath = join(envDir ?? CHANNELS_DIR, '.env')
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf-8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx)
      const val = trimmed.slice(eqIdx + 1)
      if (!process.env[key]) process.env[key] = val
    }
  }

  let homeserverUrl = requireEnv('MATRIX_HOMESERVER_URL').replace(/\/+$/, '')
  if (!homeserverUrl.startsWith('https://') && !homeserverUrl.startsWith('http://')) {
    homeserverUrl = `https://${homeserverUrl}`
  }

  const rawRoomIds = process.env.MATRIX_ROOM_IDS?.trim()
  const roomIds = rawRoomIds ? rawRoomIds.split(',').map((id) => id.trim()).filter(Boolean) : null

  return {
    homeserverUrl,
    accessToken: requireEnv('MATRIX_ACCESS_TOKEN'),
    botUserId: requireEnv('MATRIX_BOT_USER_ID'),
    roomIds,
  }
}

export function loadAccess(path?: string): Access {
  const filePath = path ?? join(CHANNELS_DIR, 'access.json')
  if (!existsSync(filePath)) {
    return { allowedUsers: [], ackReaction: null, maxImageSize: DEFAULT_MAX_IMAGE_SIZE }
  }
  let raw: any
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (err) {
    console.error(`Failed to parse ${filePath}: ${err instanceof Error ? err.message : err}`)
    console.error('Falling back to default access config (no allowed users)')
    return { allowedUsers: [], ackReaction: null, maxImageSize: DEFAULT_MAX_IMAGE_SIZE }
  }
  return {
    allowedUsers: Array.isArray(raw.allowedUsers) ? raw.allowedUsers : [],
    ackReaction: raw.ackReaction ?? null,
    maxImageSize: typeof raw.maxImageSize === 'number' ? raw.maxImageSize : 10 * 1024 * 1024,
  }
}

// ── Matrix CS API Helpers ──────────────────────────────

const SYNC_FILTER = JSON.stringify({
  room: {
    timeline: { types: ['m.room.message'], limit: 50 },
    state: { types: ['m.room.name', 'm.room.member'], lazy_load_members: true },
  },
  presence: { types: [] },
  account_data: { types: [] },
})

export interface BaseEvent {
  roomId: string
  roomName: string
  sender: string
  eventId: string
}

export interface TextEvent extends BaseEvent {
  type: 'text'
  body: string
}

export interface ImageEvent extends BaseEvent {
  type: 'image'
  body: string
  mxcUrl: string
  mimeType: string
  size: number | null
  filename: string | null
}

export type SyncEvent = TextEvent | ImageEvent

export interface SyncInvite {
  roomId: string
  inviter: string
}

let txnCounter = 0
export function nextTxnId(): string {
  return `m${Date.now()}.${txnCounter++}`
}

export function buildSyncUrl(homeserverUrl: string, since: string | null): string {
  const params = new URLSearchParams({ filter: SYNC_FILTER })
  if (since) {
    params.set('since', since)
    params.set('timeout', '30000')
  } else {
    params.set('timeout', '0')
  }
  return `${homeserverUrl}/_matrix/client/v3/sync?${params}`
}

/** Cache of room ID → human-readable name, persisted across sync batches. */
export const roomNameCache = new Map<string, string>()

export function parseSyncEvents(data: any): SyncEvent[] {
  const events: SyncEvent[] = []
  const joined = data.rooms?.join ?? {}

  for (const [roomId, room] of Object.entries<any>(joined)) {
    // Update cache if this batch carries a room name state event
    const nameEvent = (room.state?.events ?? []).find(
      (e: any) => e.type === 'm.room.name'
    )
    if (nameEvent?.content?.name) {
      roomNameCache.set(roomId, nameEvent.content.name)
    }
    const roomName: string = roomNameCache.get(roomId) ?? roomId

    for (const event of room.timeline?.events ?? []) {
      if (event.type !== 'm.room.message') continue

      const msgtype = event.content?.msgtype
      if (msgtype === 'm.text') {
        events.push({
          type: 'text',
          roomId,
          roomName,
          sender: event.sender,
          eventId: event.event_id,
          body: event.content.body,
        })
      } else if (msgtype === 'm.image') {
        if (!event.content.url) {
          if (event.content.file) {
            console.error(`Skipping encrypted image (E2EE not supported) in ${roomId}`)
            events.push({
              type: 'text',
              roomId,
              roomName,
              sender: event.sender,
              eventId: event.event_id,
              body: `[Encrypted image not supported: ${event.content.body ?? 'image'}] This room uses E2EE — the plugin cannot decrypt media.`,
            })
          }
          continue
        }
        events.push({
          type: 'image',
          roomId,
          roomName,
          sender: event.sender,
          eventId: event.event_id,
          body: event.content.body ?? event.content.filename ?? 'image',
          mxcUrl: event.content.url,
          mimeType: event.content.info?.mimetype ?? 'application/octet-stream',
          size: event.content.info?.size ?? null,
          filename: event.content.filename ?? null,
        })
      }
    }
  }

  return events
}

export function parseSyncInvites(data: any): SyncInvite[] {
  const invites: SyncInvite[] = []
  const invited = data.rooms?.invite ?? {}

  for (const [roomId, room] of Object.entries<any>(invited)) {
    const memberEvent = (room.invite_state?.events ?? []).find(
      (e: any) => e.type === 'm.room.member' && e.content?.membership === 'invite'
    )
    invites.push({
      roomId,
      inviter: memberEvent?.sender ?? 'unknown',
    })
  }

  return invites
}

export function buildMessageBody(
  text: string,
  html: string | undefined,
): Record<string, string> {
  const body: Record<string, string> = { msgtype: 'm.notice', body: text }
  if (html) {
    body.format = 'org.matrix.custom.html'
    body.formatted_body = html
  }
  return body
}

export function buildReactionBody(eventId: string, emoji: string) {
  return {
    'm.relates_to': {
      rel_type: 'm.annotation',
      event_id: eventId,
      key: emoji,
    },
  }
}

export function mxcToHttpUrl(homeserverUrl: string, mxcUrl: string): string {
  if (!mxcUrl.startsWith('mxc://')) {
    throw new Error(`Invalid MXC URL: ${mxcUrl}`)
  }
  const withoutScheme = mxcUrl.slice('mxc://'.length)
  const slashIdx = withoutScheme.indexOf('/')
  if (slashIdx <= 0 || slashIdx === withoutScheme.length - 1) {
    throw new Error(`Invalid MXC URL (missing server or media ID): ${mxcUrl}`)
  }
  const serverName = withoutScheme.slice(0, slashIdx)
  const mediaId = withoutScheme.slice(slashIdx + 1)
  return `${homeserverUrl}/_matrix/client/v1/media/download/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`
}

const IMAGE_DIR = '/tmp/claude-matrix-images'
const IMAGE_CLEANUP_DELAY_MS = 5 * 60 * 1000 // 5 minutes

/** Tracks all image files written during this session for exit cleanup. */
export const trackedImages = new Set<string>()

export function scheduleImageCleanup(filePath: string, delayMs = IMAGE_CLEANUP_DELAY_MS): void {
  setTimeout(() => {
    try {
      unlinkSync(filePath)
      trackedImages.delete(filePath)
      console.error(`Cleaned up image: ${filePath}`)
    } catch {
      trackedImages.delete(filePath)
    }
  }, delayMs).unref()
}

export function cleanupAllImages(): void {
  for (const filePath of trackedImages) {
    try {
      unlinkSync(filePath)
    } catch {
      // already gone
    }
  }
  const count = trackedImages.size
  trackedImages.clear()
  if (count > 0) {
    console.error(`Exit cleanup: removed ${count} image(s)`)
  }
  // Remove the directory itself if empty
  try {
    rmdirSync(IMAGE_DIR)
  } catch {
    // not empty or doesn't exist
  }
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
}

export function sanitizeForFilename(
  input: string,
  allowDots = false,
  maxLength = 100,
): string {
  const pattern = allowDots ? /[^a-zA-Z0-9._-]/g : /[^a-zA-Z0-9_-]/g
  return input.replace(pattern, '_').slice(0, maxLength)
}

export function buildImagePath(
  eventId: string,
  filename: string | null,
  mimeType = 'application/octet-stream',
): string {
  const safeName = filename
    ? sanitizeForFilename(filename, true)
    : `image${MIME_TO_EXT[mimeType] ?? '.bin'}`
  const safeEventId = sanitizeForFilename(eventId)
  return join(IMAGE_DIR, `${safeEventId}-${safeName}`)
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${bytes}B`
}

export async function downloadImage(
  config: Config,
  access: Access,
  event: ImageEvent,
): Promise<{ content: string; imagePath: string | null }> {
  const displayName = event.filename ?? event.body

  // Early skip if event metadata already indicates oversized image
  if (event.size && event.size > access.maxImageSize) {
    return {
      content: `[Image skipped: exceeds size limit of ${formatSize(access.maxImageSize)}] ${displayName}`,
      imagePath: null,
    }
  }

  try {
    const url = mxcToHttpUrl(config.homeserverUrl, event.mxcUrl)

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      return {
        content: `[Image download failed: HTTP ${res.status}] ${displayName}`,
        imagePath: null,
      }
    }

    // Early reject via Content-Length
    const contentLength = Number(res.headers.get('Content-Length'))
    if (contentLength && contentLength > access.maxImageSize) {
      return {
        content: `[Image skipped: exceeds size limit of ${formatSize(access.maxImageSize)}] ${displayName}`,
        imagePath: null,
      }
    }

    // Stream body and enforce size limit
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    const reader = res.body!.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > access.maxImageSize) {
        reader.cancel()
        return {
          content: `[Image skipped: exceeds size limit of ${formatSize(access.maxImageSize)}] ${displayName}`,
          imagePath: null,
        }
      }
      chunks.push(value)
    }

    // Write to disk
    const filePath = buildImagePath(event.eventId, event.filename, event.mimeType)
    mkdirSync(IMAGE_DIR, { recursive: true, mode: 0o700 })
    const buffer = Buffer.concat(chunks)
    writeFileSync(filePath, buffer, { mode: 0o600 })
    trackedImages.add(filePath)

    return {
      content: `[Image: ${displayName} (${event.mimeType}, ${formatSize(totalBytes)})]\nUse the Read tool to view the image at ${filePath}`,
      imagePath: filePath,
    }
  } catch (err: any) {
    if (err.name === 'TimeoutError') {
      return {
        content: `[Image download failed: timed out] ${displayName}`,
        imagePath: null,
      }
    }
    return {
      content: `[Image download failed: ${err.message ?? err}] ${displayName}`,
      imagePath: null,
    }
  }
}

// ── Matrix HTTP Client ─────────────────────────────────

function matrixHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }
}

async function matrixSync(
  config: Config,
  since: string | null,
): Promise<any> {
  const url = buildSyncUrl(config.homeserverUrl, since)
  const res = await fetch(url, { headers: matrixHeaders(config.accessToken) })

  if (res.status === 429) {
    const body = await res.json().catch(() => ({}))
    const retryMs = body.retry_after_ms ?? 5000
    throw Object.assign(new Error('Rate limited'), { retryMs })
  }

  if (!res.ok) {
    throw new Error(`Sync failed: ${res.status} ${await res.text()}`)
  }

  return res.json()
}

async function matrixSend(
  config: Config,
  roomId: string,
  eventType: string,
  content: Record<string, any>,
): Promise<string> {
  const txnId = nextTxnId()
  const url = `${config.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: matrixHeaders(config.accessToken),
    body: JSON.stringify(content),
  })

  if (!res.ok) {
    throw new Error(`Send failed: ${res.status} ${await res.text()}`)
  }

  const data = await res.json()
  return data.event_id
}

async function matrixJoin(config: Config, roomId: string): Promise<void> {
  const url = `${config.homeserverUrl}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: matrixHeaders(config.accessToken),
    body: '{}',
  })

  if (!res.ok) {
    console.error(`Join failed for ${roomId}: ${res.status} ${await res.text()}`)
  }
}

async function matrixReply(
  config: Config,
  roomId: string,
  text: string,
  html?: string,
): Promise<string> {
  return matrixSend(config, roomId, 'm.room.message', buildMessageBody(text, html))
}

async function matrixReact(
  config: Config,
  roomId: string,
  eventId: string,
  emoji: string,
): Promise<string> {
  return matrixSend(config, roomId, 'm.reaction', buildReactionBody(eventId, emoji))
}

// ── MCP Server ─────────────────────────────────────────

function createMcpServer(config: Config): Server {
  const mcp = new Server(
    { name: 'matrix', version: '0.3.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} },
        tools: {},
      },
      instructions:
        'Messages arrive as <channel source="matrix" room_id="!abc:domain" room_name="General" sender="@user:domain" event_id="$evt:domain">. ' +
        'Reply with the reply tool (pass room_id). React with the react tool (pass room_id, event_id, emoji). ' +
        'When a message contains an image file path, use the Read tool to view it before responding.',
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description: 'Send a message to a Matrix room',
        inputSchema: {
          type: 'object' as const,
          properties: {
            room_id: { type: 'string', description: 'The room to send to (from channel tag)' },
            text: { type: 'string', description: 'Plain text message' },
            html: { type: 'string', description: 'Optional HTML-formatted message' },
          },
          required: ['room_id', 'text'],
        },
      },
      {
        name: 'react',
        description: 'React to a message with an emoji',
        inputSchema: {
          type: 'object' as const,
          properties: {
            room_id: { type: 'string', description: 'The room the message is in' },
            event_id: { type: 'string', description: 'The event to react to' },
            emoji: { type: 'string', description: 'Emoji to react with' },
          },
          required: ['room_id', 'event_id', 'emoji'],
        },
      },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, string>

    switch (req.params.name) {
      case 'reply': {
        if (!args.room_id || !args.text) {
          return { content: [{ type: 'text', text: 'Missing required arguments: room_id and text' }], isError: true }
        }
        await matrixReply(config, args.room_id, args.text, args.html)
        return { content: [{ type: 'text', text: 'sent' }] }
      }
      case 'react': {
        if (!args.room_id || !args.event_id || !args.emoji) {
          return { content: [{ type: 'text', text: 'Missing required arguments: room_id, event_id, and emoji' }], isError: true }
        }
        await matrixReact(config, args.room_id, args.event_id, args.emoji)
        return { content: [{ type: 'text', text: 'reacted' }] }
      }
      default:
        throw new Error(`Unknown tool: ${req.params.name}`)
    }
  })

  return mcp
}

// ── Event Gating ───────────────────────────────────────

export function shouldForwardEvent(
  event: SyncEvent,
  access: Access,
  botUserId: string,
  roomIds: string[] | null = null,
): boolean {
  if (event.sender === botUserId) return false
  if (!access.allowedUsers.includes(event.sender)) return false
  if (roomIds && !roomIds.includes(event.roomId)) return false
  return true
}

export function shouldAutoJoin(
  invite: SyncInvite,
  access: Access,
  roomIds: string[] | null = null,
): boolean {
  if (!access.allowedUsers.includes(invite.inviter)) return false
  if (roomIds && !roomIds.includes(invite.roomId)) return false
  return true
}

// ── Sync Loop ──────────────────────────────────────────

async function runSyncLoop(
  config: Config,
  access: Access,
  mcp: Server,
): Promise<never> {
  let since: string | null = null
  let backoffMs = 5000

  // Initial sync — grab state, process pending invites, discard message history
  try {
    console.error('Starting initial sync...')
    const data = await matrixSync(config, null)
    since = data.next_batch
    console.error(`Initial sync complete. Token: ${since}`)

    // Process any pending invites from before the plugin started
    const pendingInvites = parseSyncInvites(data)
    for (const invite of pendingInvites) {
      if (shouldAutoJoin(invite, access, config.roomIds)) {
        console.error(`Auto-joining room ${invite.roomId} (pending invite from ${invite.inviter})`)
        matrixJoin(config, invite.roomId).catch((err) =>
          console.error(`Failed to join ${invite.roomId}:`, err)
        )
      }
    }
  } catch (err) {
    console.error('Initial sync failed:', err)
    throw err
  }

  // Incremental sync loop
  while (true) {
    try {
      const data = await matrixSync(config, since)

      // Process invites
      const invites = parseSyncInvites(data)
      for (const invite of invites) {
        if (shouldAutoJoin(invite, access, config.roomIds)) {
          console.error(`Auto-joining room ${invite.roomId} (invited by ${invite.inviter})`)
          matrixJoin(config, invite.roomId).catch((err) =>
            console.error(`Failed to join ${invite.roomId}:`, err)
          )
        } else {
          console.error(`Ignoring invite to ${invite.roomId} from ${invite.inviter} (not in allowlist)`)
        }
      }

      // Process messages
      const events = parseSyncEvents(data)
      for (const event of events) {
        if (!shouldForwardEvent(event, access, config.botUserId, config.roomIds)) continue

        let content: string
        const meta: Record<string, string> = {
          room_id: event.roomId,
          room_name: event.roomName,
          sender: event.sender,
          event_id: event.eventId,
        }

        if (event.type === 'text') {
          content = event.body
        } else {
          const result = await downloadImage(config, access, event)
          content = result.content
          if (result.imagePath) {
            meta.image_path = result.imagePath
          }
        }

        // Forward to Claude
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: { content, meta },
        })

        // Schedule image cleanup after Claude has had time to read it
        if (meta.image_path) {
          scheduleImageCleanup(meta.image_path)
        }

        // Ack reaction
        if (access.ackReaction) {
          matrixReact(config, event.roomId, event.eventId, access.ackReaction).catch((err) =>
            console.error(`Ack reaction failed for ${event.eventId}:`, err)
          )
        }
      }

      since = data.next_batch
      backoffMs = 5000 // reset on success
    } catch (err: any) {
      const waitMs = err.retryMs ?? backoffMs
      console.error(`Sync error, retrying in ${waitMs}ms:`, err.message ?? err)
      await new Promise((r) => setTimeout(r, waitMs))
      backoffMs = Math.min(backoffMs * 2, 60000)
    }
  }
}

// ── Main ───────────────────────────────────────────────

if (import.meta.main) {
  const config = loadConfig()
  const access = loadAccess()

  // Clean up downloaded images on exit
  process.on('SIGINT', () => { cleanupAllImages(); process.exit(0) })
  process.on('SIGTERM', () => { cleanupAllImages(); process.exit(0) })
  process.on('exit', cleanupAllImages)

  console.error(`Matrix channel starting for ${config.botUserId}`)
  console.error(`Homeserver: ${config.homeserverUrl}`)
  console.error(`Allowed users: ${access.allowedUsers.join(', ') || '(none)'}`)
  console.error(`Room filter: ${config.roomIds ? config.roomIds.join(', ') : '(all rooms)'}`)

  const mcp = createMcpServer(config)
  await mcp.connect(new StdioServerTransport())

  runSyncLoop(config, access, mcp).catch((err) => {
    console.error('Fatal sync loop error:', err)
    process.exit(1)
  })
}
