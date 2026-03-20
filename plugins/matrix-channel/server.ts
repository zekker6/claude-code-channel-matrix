#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs'
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
}

export interface Access {
  allowedUsers: string[]
  ackReaction: string | null
}

// ── Config ─────────────────────────────────────────────

const CHANNELS_DIR = join(homedir(), '.claude', 'channels', 'matrix')

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

  return {
    homeserverUrl,
    accessToken: requireEnv('MATRIX_ACCESS_TOKEN'),
    botUserId: requireEnv('MATRIX_BOT_USER_ID'),
  }
}

export function loadAccess(path?: string): Access {
  const filePath = path ?? join(CHANNELS_DIR, 'access.json')
  if (!existsSync(filePath)) {
    return { allowedUsers: [], ackReaction: null }
  }
  let raw: any
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (err) {
    console.error(`Failed to parse ${filePath}: ${err instanceof Error ? err.message : err}`)
    console.error('Falling back to default access config (no allowed users)')
    return { allowedUsers: [], ackReaction: null }
  }
  return {
    allowedUsers: Array.isArray(raw.allowedUsers) ? raw.allowedUsers : [],
    ackReaction: raw.ackReaction ?? null,
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

export interface SyncEvent {
  roomId: string
  roomName: string
  sender: string
  eventId: string
  body: string
}

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
      if (event.content?.msgtype !== 'm.text') continue

      events.push({
        roomId,
        roomName,
        sender: event.sender,
        eventId: event.event_id,
        body: event.content.body,
      })
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
    { name: 'matrix', version: '0.1.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} },
        tools: {},
      },
      instructions:
        'Messages arrive as <channel source="matrix" room_id="!abc:domain" room_name="General" sender="@user:domain" event_id="$evt:domain">. ' +
        'Reply with the reply tool (pass room_id). React with the react tool (pass room_id, event_id, emoji).',
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
): boolean {
  if (event.sender === botUserId) return false
  return access.allowedUsers.includes(event.sender)
}

export function shouldAutoJoin(
  invite: SyncInvite,
  access: Access,
): boolean {
  return access.allowedUsers.includes(invite.inviter)
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
      if (shouldAutoJoin(invite, access)) {
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
        if (shouldAutoJoin(invite, access)) {
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
        if (!shouldForwardEvent(event, access, config.botUserId)) continue

        // Forward to Claude
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: event.body,
            meta: {
              room_id: event.roomId,
              room_name: event.roomName,
              sender: event.sender,
              event_id: event.eventId,
            },
          },
        })

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

  console.error(`Matrix channel starting for ${config.botUserId}`)
  console.error(`Homeserver: ${config.homeserverUrl}`)
  console.error(`Allowed users: ${access.allowedUsers.join(', ') || '(none)'}`)

  const mcp = createMcpServer(config)
  await mcp.connect(new StdioServerTransport())

  runSyncLoop(config, access, mcp).catch((err) => {
    console.error('Fatal sync loop error:', err)
    process.exit(1)
  })
}
