import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { loadConfig, loadAccess, type Config, type Access } from './server'
import { shouldForwardEvent, shouldAutoJoin, type SyncEvent, type SyncInvite } from './server'

describe('loadConfig', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('loads config from environment variables', () => {
    process.env.MATRIX_HOMESERVER_URL = 'https://matrix.example.com'
    process.env.MATRIX_ACCESS_TOKEN = 'syt_test_token'
    process.env.MATRIX_BOT_USER_ID = '@bot:example.com'

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.homeserverUrl).toBe('https://matrix.example.com')
    expect(config.accessToken).toBe('syt_test_token')
    expect(config.botUserId).toBe('@bot:example.com')
  })

  test('strips trailing slash from homeserver URL', () => {
    process.env.MATRIX_HOMESERVER_URL = 'https://matrix.example.com/'
    process.env.MATRIX_ACCESS_TOKEN = 'token'
    process.env.MATRIX_BOT_USER_ID = '@bot:example.com'

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.homeserverUrl).toBe('https://matrix.example.com')
  })

  test('prepends https:// when protocol is missing', () => {
    process.env.MATRIX_HOMESERVER_URL = 'matrix.example.com'
    process.env.MATRIX_ACCESS_TOKEN = 'token'
    process.env.MATRIX_BOT_USER_ID = '@bot:example.com'

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.homeserverUrl).toBe('https://matrix.example.com')
  })

  test('throws if MATRIX_HOMESERVER_URL is missing', () => {
    delete process.env.MATRIX_HOMESERVER_URL
    process.env.MATRIX_ACCESS_TOKEN = 'token'
    process.env.MATRIX_BOT_USER_ID = '@bot:example.com'

    expect(() => loadConfig('/tmp/no-such-dir')).toThrow('MATRIX_HOMESERVER_URL')
  })

  test('throws if MATRIX_ACCESS_TOKEN is missing', () => {
    process.env.MATRIX_HOMESERVER_URL = 'https://matrix.example.com'
    delete process.env.MATRIX_ACCESS_TOKEN
    process.env.MATRIX_BOT_USER_ID = '@bot:example.com'

    expect(() => loadConfig('/tmp/no-such-dir')).toThrow('MATRIX_ACCESS_TOKEN')
  })

  test('throws if MATRIX_BOT_USER_ID is missing', () => {
    process.env.MATRIX_HOMESERVER_URL = 'https://matrix.example.com'
    process.env.MATRIX_ACCESS_TOKEN = 'token'
    delete process.env.MATRIX_BOT_USER_ID

    expect(() => loadConfig('/tmp/no-such-dir')).toThrow('MATRIX_BOT_USER_ID')
  })
})

describe('loadAccess', () => {
  test('returns defaults when file does not exist', () => {
    const access = loadAccess('/tmp/nonexistent-access.json')
    expect(access.allowedUsers).toEqual([])
    expect(access.ackReaction).toBeNull()
  })

  test('returns defaults when file contains malformed JSON', async () => {
    const path = '/tmp/test-bad-access.json'
    await Bun.write(path, '{not valid json')

    const access = loadAccess(path)
    expect(access.allowedUsers).toEqual([])
    expect(access.ackReaction).toBeNull()
  })

  test('loads allowedUsers and ackReaction from JSON file', async () => {
    const path = '/tmp/test-access.json'
    await Bun.write(path, JSON.stringify({
      allowedUsers: ['@alice:example.com'],
      ackReaction: '👀',
    }))

    const access = loadAccess(path)
    expect(access.allowedUsers).toEqual(['@alice:example.com'])
    expect(access.ackReaction).toBe('👀')
  })
})

import {
  buildSyncUrl,
  parseSyncEvents,
  parseSyncInvites,
  buildMessageBody,
  buildReactionBody,
  nextTxnId,
  roomNameCache,
} from './server'

describe('buildSyncUrl', () => {
  const base = 'https://matrix.example.com'

  test('builds initial sync URL with timeout=0', () => {
    const url = buildSyncUrl(base, null)
    expect(url).toContain('timeout=0')
    expect(url).not.toContain('since=')
    expect(url).toContain('filter=')
  })

  test('builds incremental sync URL with since token', () => {
    const url = buildSyncUrl(base, 's1234')
    expect(url).toContain('since=s1234')
    expect(url).toContain('timeout=30000')
  })
})

describe('parseSyncEvents', () => {
  test('extracts m.room.message events from joined rooms', () => {
    const syncResponse = {
      next_batch: 's_next',
      rooms: {
        join: {
          '!room1:example.com': {
            timeline: {
              events: [
                {
                  type: 'm.room.message',
                  sender: '@alice:example.com',
                  event_id: '$evt1',
                  content: { msgtype: 'm.text', body: 'hello' },
                },
              ],
            },
            state: {
              events: [
                { type: 'm.room.name', content: { name: 'General' } },
              ],
            },
          },
        },
      },
    }

    const events = parseSyncEvents(syncResponse)
    expect(events).toHaveLength(1)
    expect(events[0].roomId).toBe('!room1:example.com')
    expect(events[0].roomName).toBe('General')
    expect(events[0].sender).toBe('@alice:example.com')
    expect(events[0].eventId).toBe('$evt1')
    expect(events[0].body).toBe('hello')
  })

  test('returns empty array when no rooms', () => {
    const events = parseSyncEvents({ next_batch: 's', rooms: {} })
    expect(events).toEqual([])
  })

  test('uses cached room name when incremental sync omits state', () => {
    roomNameCache.clear()

    // First sync batch delivers the room name in state
    const batch1 = {
      rooms: {
        join: {
          '!room1:example.com': {
            timeline: { events: [] },
            state: {
              events: [{ type: 'm.room.name', content: { name: 'General' } }],
            },
          },
        },
      },
    }
    parseSyncEvents(batch1)

    // Second sync batch has a message but no state events (typical incremental sync)
    const batch2 = {
      rooms: {
        join: {
          '!room1:example.com': {
            timeline: {
              events: [
                {
                  type: 'm.room.message',
                  sender: '@alice:example.com',
                  event_id: '$evt2',
                  content: { msgtype: 'm.text', body: 'hello' },
                },
              ],
            },
            state: { events: [] },
          },
        },
      },
    }

    const events = parseSyncEvents(batch2)
    expect(events).toHaveLength(1)
    expect(events[0].roomName).toBe('General')
  })

  test('skips non-m.text messages', () => {
    const syncResponse = {
      next_batch: 's',
      rooms: {
        join: {
          '!r:x': {
            timeline: {
              events: [
                {
                  type: 'm.room.message',
                  sender: '@a:x',
                  event_id: '$1',
                  content: { msgtype: 'm.image', body: 'photo.jpg' },
                },
              ],
            },
            state: { events: [] },
          },
        },
      },
    }

    const events = parseSyncEvents(syncResponse)
    expect(events).toHaveLength(0)
  })
})

describe('parseSyncInvites', () => {
  test('extracts invited room IDs with inviter', () => {
    const syncResponse = {
      next_batch: 's',
      rooms: {
        invite: {
          '!newroom:example.com': {
            invite_state: {
              events: [
                {
                  type: 'm.room.member',
                  sender: '@alice:example.com',
                  content: { membership: 'invite' },
                },
              ],
            },
          },
        },
      },
    }

    const invites = parseSyncInvites(syncResponse)
    expect(invites).toHaveLength(1)
    expect(invites[0].roomId).toBe('!newroom:example.com')
    expect(invites[0].inviter).toBe('@alice:example.com')
  })

  test('returns empty array when no invites', () => {
    const invites = parseSyncInvites({ next_batch: 's', rooms: {} })
    expect(invites).toEqual([])
  })
})

describe('buildMessageBody', () => {
  test('builds plain text m.notice body', () => {
    const body = buildMessageBody('hello', undefined)
    expect(body.msgtype).toBe('m.notice')
    expect(body.body).toBe('hello')
    expect(body.format).toBeUndefined()
  })

  test('builds HTML m.notice body', () => {
    const body = buildMessageBody('hello', '<b>hello</b>')
    expect(body.msgtype).toBe('m.notice')
    expect(body.body).toBe('hello')
    expect(body.format).toBe('org.matrix.custom.html')
    expect(body.formatted_body).toBe('<b>hello</b>')
  })
})

describe('buildReactionBody', () => {
  test('builds m.reaction content', () => {
    const body = buildReactionBody('$evt1', '👍')
    expect(body['m.relates_to'].rel_type).toBe('m.annotation')
    expect(body['m.relates_to'].event_id).toBe('$evt1')
    expect(body['m.relates_to'].key).toBe('👍')
  })
})

describe('nextTxnId', () => {
  test('returns incrementing unique IDs', () => {
    const a = nextTxnId()
    const b = nextTxnId()
    expect(a).not.toBe(b)
  })
})

describe('shouldForwardEvent', () => {
  const access: Access = {
    allowedUsers: ['@alice:example.com', '@bob:example.com'],
    ackReaction: '👀',
  }
  const botUserId = '@bot:example.com'

  test('forwards events from allowed users', () => {
    const event: SyncEvent = {
      roomId: '!r:x', roomName: 'General',
      sender: '@alice:example.com', eventId: '$1', body: 'hi',
    }
    expect(shouldForwardEvent(event, access, botUserId)).toBe(true)
  })

  test('drops events from non-allowed users', () => {
    const event: SyncEvent = {
      roomId: '!r:x', roomName: 'General',
      sender: '@mallory:example.com', eventId: '$1', body: 'hi',
    }
    expect(shouldForwardEvent(event, access, botUserId)).toBe(false)
  })

  test('drops events from the bot itself', () => {
    const event: SyncEvent = {
      roomId: '!r:x', roomName: 'General',
      sender: '@bot:example.com', eventId: '$1', body: 'hi',
    }
    expect(shouldForwardEvent(event, access, botUserId)).toBe(false)
  })

  test('drops all events when allowedUsers is empty', () => {
    const emptyAccess: Access = { allowedUsers: [], ackReaction: null }
    const event: SyncEvent = {
      roomId: '!r:x', roomName: 'General',
      sender: '@alice:example.com', eventId: '$1', body: 'hi',
    }
    expect(shouldForwardEvent(event, emptyAccess, botUserId)).toBe(false)
  })
})

describe('shouldAutoJoin', () => {
  const access: Access = {
    allowedUsers: ['@alice:example.com'],
    ackReaction: null,
  }

  test('joins when inviter is in allowedUsers', () => {
    expect(shouldAutoJoin({ roomId: '!r:x', inviter: '@alice:example.com' }, access)).toBe(true)
  })

  test('ignores when inviter is not in allowedUsers', () => {
    expect(shouldAutoJoin({ roomId: '!r:x', inviter: '@mallory:example.com' }, access)).toBe(false)
  })
})
