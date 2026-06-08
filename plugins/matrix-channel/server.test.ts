import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { loadConfig, loadAccess, DEFAULT_MAX_IMAGE_SIZE, type Config, type Access } from './server'
import { shouldForwardEvent, shouldAutoJoin, type SyncEvent, type SyncInvite, type TextEvent, type ImageEvent } from './server'
import { downloadImage, scheduleImageCleanup, cleanupAllImages, trackedImages } from './server'
import { loadThreadRoots, saveThreadRoot } from './server'
import {
  parseSyncReactions,
  shouldHonorReaction,
  classifyVerdict,
  pickPermissionRoom,
  buildPermissionPromptText,
  expirePendingPermissions,
  processReactions,
  pendingPermissions,
  lastActiveRoomState,
  ALLOW_EMOJI,
  DENY_EMOJI,
  type ReactionEvent,
} from './server'
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

describe('loadConfig', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('loads config from environment variables', () => {
    process.env.MATRIX_HOMESERVER_URL = 'https://matrix.example.com'
    process.env.MATRIX_ACCESS_TOKEN = 'syt_test_token'
    process.env.MATRIX_BOT_USER_ID = '@bot:example.com'
    delete process.env.MATRIX_THREADS
    delete process.env.MATRIX_THREAD_ROOT_ROOM_ID

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.homeserverUrl).toBe('https://matrix.example.com')
    expect(config.accessToken).toBe('syt_test_token')
    expect(config.botUserId).toBe('@bot:example.com')
  })

  test('strips trailing slash from homeserver URL', () => {
    process.env.MATRIX_HOMESERVER_URL = 'https://matrix.example.com/'
    process.env.MATRIX_ACCESS_TOKEN = 'token'
    process.env.MATRIX_BOT_USER_ID = '@bot:example.com'
    delete process.env.MATRIX_THREADS
    delete process.env.MATRIX_THREAD_ROOT_ROOM_ID

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.homeserverUrl).toBe('https://matrix.example.com')
  })

  test('prepends https:// when protocol is missing', () => {
    process.env.MATRIX_HOMESERVER_URL = 'matrix.example.com'
    process.env.MATRIX_ACCESS_TOKEN = 'token'
    process.env.MATRIX_BOT_USER_ID = '@bot:example.com'
    delete process.env.MATRIX_THREADS
    delete process.env.MATRIX_THREAD_ROOT_ROOM_ID

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.homeserverUrl).toBe('https://matrix.example.com')
  })

  test('throws if MATRIX_HOMESERVER_URL is missing', () => {
    delete process.env.MATRIX_HOMESERVER_URL
    process.env.MATRIX_ACCESS_TOKEN = 'token'
    process.env.MATRIX_BOT_USER_ID = '@bot:example.com'
    delete process.env.MATRIX_THREADS
    delete process.env.MATRIX_THREAD_ROOT_ROOM_ID

    expect(() => loadConfig('/tmp/no-such-dir')).toThrow('MATRIX_HOMESERVER_URL')
  })

  test('throws if MATRIX_ACCESS_TOKEN is missing', () => {
    process.env.MATRIX_HOMESERVER_URL = 'https://matrix.example.com'
    delete process.env.MATRIX_ACCESS_TOKEN
    process.env.MATRIX_BOT_USER_ID = '@bot:example.com'
    delete process.env.MATRIX_THREADS
    delete process.env.MATRIX_THREAD_ROOT_ROOM_ID

    expect(() => loadConfig('/tmp/no-such-dir')).toThrow('MATRIX_ACCESS_TOKEN')
  })

  test('throws if MATRIX_BOT_USER_ID is missing', () => {
    process.env.MATRIX_HOMESERVER_URL = 'https://matrix.example.com'
    process.env.MATRIX_ACCESS_TOKEN = 'token'
    delete process.env.MATRIX_BOT_USER_ID
    delete process.env.MATRIX_THREADS
    delete process.env.MATRIX_THREAD_ROOT_ROOM_ID

    expect(() => loadConfig('/tmp/no-such-dir')).toThrow('MATRIX_BOT_USER_ID')
  })

  test('parses MATRIX_ROOM_IDS as comma-separated list', () => {
    process.env.MATRIX_HOMESERVER_URL = 'https://matrix.example.com'
    process.env.MATRIX_ACCESS_TOKEN = 'token'
    process.env.MATRIX_BOT_USER_ID = '@bot:example.com'
    process.env.MATRIX_ROOM_IDS = '!room1:example.com, !room2:example.com'
    delete process.env.MATRIX_THREADS
    delete process.env.MATRIX_THREAD_ROOT_ROOM_ID

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.roomIds).toEqual(['!room1:example.com', '!room2:example.com'])
  })

  test('returns null roomIds when MATRIX_ROOM_IDS is not set', () => {
    process.env.MATRIX_HOMESERVER_URL = 'https://matrix.example.com'
    process.env.MATRIX_ACCESS_TOKEN = 'token'
    process.env.MATRIX_BOT_USER_ID = '@bot:example.com'
    delete process.env.MATRIX_ROOM_IDS
    delete process.env.MATRIX_THREADS
    delete process.env.MATRIX_THREAD_ROOT_ROOM_ID

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.roomIds).toBeNull()
  })
})

describe('loadConfig thread settings', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  const baseEnv = () => {
    process.env.MATRIX_HOMESERVER_URL = 'https://matrix.example.com'
    process.env.MATRIX_ACCESS_TOKEN = 'token'
    process.env.MATRIX_BOT_USER_ID = '@bot:example.com'
  }

  test('returns null threadProject when MATRIX_THREADS is not set', () => {
    baseEnv()
    delete process.env.MATRIX_THREADS
    delete process.env.MATRIX_ROOM_IDS

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.threadProject).toBeNull()
  })

  test('auto-detects threadProject from cwd basename when MATRIX_THREADS=true', () => {
    baseEnv()
    process.env.MATRIX_THREADS = 'true'
    process.env.MATRIX_THREAD_ROOT_ROOM_ID = '!room1:example.com'
    delete process.env.MATRIX_THREAD_PROJECT

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.threadProject).toBe(require('node:path').basename(process.cwd()))
  })

  test('uses MATRIX_THREAD_PROJECT override when set', () => {
    baseEnv()
    process.env.MATRIX_THREADS = 'true'
    process.env.MATRIX_THREAD_ROOT_ROOM_ID = '!room1:example.com'
    process.env.MATRIX_THREAD_PROJECT = 'my-custom-project'

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.threadProject).toBe('my-custom-project')
  })

  test('ignores MATRIX_THREAD_PROJECT when MATRIX_THREADS is not true', () => {
    baseEnv()
    delete process.env.MATRIX_THREADS
    process.env.MATRIX_THREAD_PROJECT = 'my-custom-project'

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.threadProject).toBeNull()
  })

  test('throws when MATRIX_THREAD_ROOT_ROOM_ID is set without MATRIX_THREADS=true', () => {
    baseEnv()
    delete process.env.MATRIX_THREADS
    process.env.MATRIX_THREAD_ROOT_ROOM_ID = '!anchor:example.com'

    expect(() => loadConfig('/tmp/no-such-dir')).toThrow('MATRIX_THREAD_ROOT_ROOM_ID requires MATRIX_THREADS=true')
  })

  test('throws when MATRIX_THREADS=true without MATRIX_THREAD_ROOT_ROOM_ID', () => {
    baseEnv()
    process.env.MATRIX_THREADS = 'true'
    delete process.env.MATRIX_THREAD_ROOT_ROOM_ID

    expect(() => loadConfig('/tmp/no-such-dir')).toThrow('MATRIX_THREADS=true requires MATRIX_THREAD_ROOT_ROOM_ID')
  })

  test('throws when both MATRIX_ROOM_IDS and MATRIX_THREAD_ROOT_ROOM_ID are set', () => {
    baseEnv()
    process.env.MATRIX_THREADS = 'true'
    process.env.MATRIX_ROOM_IDS = '!room1:example.com'
    process.env.MATRIX_THREAD_ROOT_ROOM_ID = '!anchor:example.com'

    expect(() => loadConfig('/tmp/no-such-dir')).toThrow('MATRIX_ROOM_IDS and MATRIX_THREAD_ROOT_ROOM_ID are mutually exclusive')
  })

  test('sets roomIds to [threadRootRoomId] in thread mode', () => {
    baseEnv()
    process.env.MATRIX_THREADS = 'true'
    process.env.MATRIX_THREAD_ROOT_ROOM_ID = '!anchor:example.com'
    delete process.env.MATRIX_ROOM_IDS

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.roomIds).toEqual(['!anchor:example.com'])
    expect(config.threadRootRoomId).toBe('!anchor:example.com')
    expect(config.threadProject).toBeTruthy()
  })

  test('returns null threadRootRoomId in room mode', () => {
    baseEnv()
    process.env.MATRIX_ROOM_IDS = '!room1:example.com'
    delete process.env.MATRIX_THREADS
    delete process.env.MATRIX_THREAD_ROOT_ROOM_ID

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.threadRootRoomId).toBeNull()
    expect(config.threadProject).toBeNull()
  })

  test('treats MATRIX_THREADS=false same as unset', () => {
    baseEnv()
    process.env.MATRIX_THREADS = 'false'
    delete process.env.MATRIX_THREAD_ROOT_ROOM_ID
    delete process.env.MATRIX_ROOM_IDS

    const config = loadConfig('/tmp/no-such-dir')
    expect(config.threadProject).toBeNull()
    expect(config.threadRootRoomId).toBeNull()
  })

  test('throws when MATRIX_THREADS=false with MATRIX_THREAD_ROOT_ROOM_ID set', () => {
    baseEnv()
    process.env.MATRIX_THREADS = 'false'
    process.env.MATRIX_THREAD_ROOT_ROOM_ID = '!anchor:example.com'

    expect(() => loadConfig('/tmp/no-such-dir')).toThrow('MATRIX_THREAD_ROOT_ROOM_ID requires MATRIX_THREADS=true')
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

  test('loads maxImageSize from JSON file', async () => {
    const path = '/tmp/test-access-imgsize.json'
    await Bun.write(path, JSON.stringify({
      allowedUsers: ['@alice:example.com'],
      ackReaction: '👀',
      maxImageSize: 5242880,
    }))

    const access = loadAccess(path)
    expect(access.maxImageSize).toBe(5242880)
  })

  test('defaults maxImageSize to 10MB when absent', () => {
    const access = loadAccess('/tmp/nonexistent-access.json')
    expect(access.maxImageSize).toBe(DEFAULT_MAX_IMAGE_SIZE)
  })

  test('defaults maxImageSize when value is not a number', async () => {
    const path = '/tmp/test-access-badsize.json'
    await Bun.write(path, JSON.stringify({
      allowedUsers: [],
      maxImageSize: 'big',
    }))

    const access = loadAccess(path)
    expect(access.maxImageSize).toBe(DEFAULT_MAX_IMAGE_SIZE)
  })
})

import {
  buildSyncUrl,
  parseSyncEvents,
  parseSyncInvites,
  buildMessageBody,
  buildReactionBody,
  buildThreadRootBody,
  nextTxnId,
  roomNameCache,
  sanitizeForFilename,
  buildImagePath,
  mxcToHttpUrl,
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

  test('produces TextEvent with type discriminant', () => {
    const syncResponse = {
      rooms: {
        join: {
          '!r:x': {
            timeline: {
              events: [{
                type: 'm.room.message',
                sender: '@a:x',
                event_id: '$1',
                content: { msgtype: 'm.text', body: 'hi' },
              }],
            },
            state: { events: [] },
          },
        },
      },
    }
    const events = parseSyncEvents(syncResponse)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('text')
  })

  test('produces ImageEvent for m.image messages', () => {
    const syncResponse = {
      rooms: {
        join: {
          '!r:x': {
            timeline: {
              events: [{
                type: 'm.room.message',
                sender: '@a:x',
                event_id: '$1',
                content: {
                  msgtype: 'm.image',
                  body: 'photo.jpg',
                  url: 'mxc://example.com/abc123',
                  filename: 'photo.jpg',
                  info: { mimetype: 'image/jpeg', size: 12345 },
                },
              }],
            },
            state: { events: [] },
          },
        },
      },
    }

    const events = parseSyncEvents(syncResponse)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('image')
    const img = events[0] as ImageEvent
    expect(img.mxcUrl).toBe('mxc://example.com/abc123')
    expect(img.mimeType).toBe('image/jpeg')
    expect(img.size).toBe(12345)
    expect(img.filename).toBe('photo.jpg')
    expect(img.body).toBe('photo.jpg')
  })

  test('produces TextEvent with explanation for encrypted images', () => {
    const syncResponse = {
      rooms: {
        join: {
          '!r:x': {
            timeline: {
              events: [{
                type: 'm.room.message',
                sender: '@a:x',
                event_id: '$1',
                content: {
                  msgtype: 'm.image',
                  body: 'photo.jpg',
                  file: { url: 'mxc://example.com/encrypted', key: {} },
                },
              }],
            },
            state: { events: [] },
          },
        },
      },
    }

    const events = parseSyncEvents(syncResponse)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('text')
    expect(events[0].body).toContain('Encrypted image not supported')
    expect(events[0].body).toContain('photo.jpg')
  })

  test('skips m.image with no url and no file (malformed)', () => {
    const syncResponse = {
      rooms: {
        join: {
          '!r:x': {
            timeline: {
              events: [{
                type: 'm.room.message',
                sender: '@a:x',
                event_id: '$1',
                content: { msgtype: 'm.image', body: 'photo.jpg' },
              }],
            },
            state: { events: [] },
          },
        },
      },
    }

    const events = parseSyncEvents(syncResponse)
    expect(events).toHaveLength(0)
  })

  test('handles m.image with missing info gracefully', () => {
    const syncResponse = {
      rooms: {
        join: {
          '!r:x': {
            timeline: {
              events: [{
                type: 'm.room.message',
                sender: '@a:x',
                event_id: '$1',
                content: {
                  msgtype: 'm.image',
                  body: 'photo.jpg',
                  url: 'mxc://example.com/abc123',
                },
              }],
            },
            state: { events: [] },
          },
        },
      },
    }

    const events = parseSyncEvents(syncResponse)
    expect(events).toHaveLength(1)
    const img = events[0] as ImageEvent
    expect(img.mimeType).toBe('application/octet-stream')
    expect(img.size).toBeNull()
    expect(img.filename).toBeNull()
  })

  test('skips unknown msgtypes like m.video', () => {
    const syncResponse = {
      rooms: {
        join: {
          '!r:x': {
            timeline: {
              events: [{
                type: 'm.room.message',
                sender: '@a:x',
                event_id: '$1',
                content: { msgtype: 'm.video', body: 'video.mp4', url: 'mxc://x/y' },
              }],
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

describe('buildMessageBody with threads', () => {
  test('includes m.relates_to when threadRootId is provided', () => {
    const body = buildMessageBody('hello', undefined, '$root1')
    expect(body['m.relates_to']).toEqual({
      rel_type: 'm.thread',
      event_id: '$root1',
      is_falling_back: true,
      'm.in_reply_to': { event_id: '$root1' },
    })
  })

  test('omits m.relates_to when threadRootId is undefined', () => {
    const body = buildMessageBody('hello', undefined)
    expect(body['m.relates_to']).toBeUndefined()
  })

  test('includes both HTML and thread info', () => {
    const body = buildMessageBody('hello', '<b>hello</b>', '$root1')
    expect(body.format).toBe('org.matrix.custom.html')
    expect(body.formatted_body).toBe('<b>hello</b>')
    expect(body['m.relates_to']).toEqual({
      rel_type: 'm.thread',
      event_id: '$root1',
      is_falling_back: true,
      'm.in_reply_to': { event_id: '$root1' },
    })
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

describe('buildThreadRootBody', () => {
  test('creates a descriptive thread root message', () => {
    const body = buildThreadRootBody('my-project')
    expect(body.msgtype).toBe('m.notice')
    expect(body.body).toContain('my-project')
  })
})

describe('nextTxnId', () => {
  test('returns incrementing unique IDs', () => {
    const a = nextTxnId()
    const b = nextTxnId()
    expect(a).not.toBe(b)
  })
})

describe('mxcToHttpUrl', () => {
  const base = 'https://matrix.example.com'

  test('converts valid mxc URL to authenticated download endpoint', () => {
    const url = mxcToHttpUrl(base, 'mxc://example.com/abc123')
    expect(url).toBe('https://matrix.example.com/_matrix/client/v1/media/download/example.com/abc123')
  })

  test('handles homeserver with different domain than media server', () => {
    const url = mxcToHttpUrl(base, 'mxc://other.server/media456')
    expect(url).toBe('https://matrix.example.com/_matrix/client/v1/media/download/other.server/media456')
  })

  test('handles server name with port', () => {
    const url = mxcToHttpUrl(base, 'mxc://example.com:8448/abc123')
    expect(url).toBe('https://matrix.example.com/_matrix/client/v1/media/download/example.com%3A8448/abc123')
  })

  test('throws for non-mxc URL', () => {
    expect(() => mxcToHttpUrl(base, 'https://example.com/file.png')).toThrow()
  })

  test('throws for mxc URL missing media ID', () => {
    expect(() => mxcToHttpUrl(base, 'mxc://example.com')).toThrow()
  })

  test('throws for mxc URL missing server name', () => {
    expect(() => mxcToHttpUrl(base, 'mxc://')).toThrow()
  })

  test('throws for empty string', () => {
    expect(() => mxcToHttpUrl(base, '')).toThrow()
  })
})

describe('sanitizeForFilename', () => {
  test('replaces special characters with underscores', () => {
    expect(sanitizeForFilename('$evt1:example.com')).toBe('_evt1_example_com')
  })

  test('preserves alphanumeric characters', () => {
    expect(sanitizeForFilename('abc123')).toBe('abc123')
  })

  test('preserves dots and hyphens when allowDots is true', () => {
    expect(sanitizeForFilename('photo.png', true)).toBe('photo.png')
    expect(sanitizeForFilename('my-file.jpg', true)).toBe('my-file.jpg')
  })

  test('replaces dots when allowDots is false (default)', () => {
    expect(sanitizeForFilename('photo.png')).toBe('photo_png')
  })

  test('truncates to maxLength', () => {
    const long = 'a'.repeat(200)
    expect(sanitizeForFilename(long, false, 100)).toHaveLength(100)
  })

  test('strips path traversal characters but preserves dots when allowDots is true', () => {
    expect(sanitizeForFilename('../../etc/passwd', true)).toBe('.._.._etc_passwd')
  })
})

describe('buildImagePath', () => {
  test('builds path from event ID and filename', () => {
    const path = buildImagePath('$evt1:example.com', 'photo.png')
    expect(path).toBe('/tmp/claude-matrix-images/_evt1_example_com-photo.png')
  })

  test('derives filename from MIME type when filename is null', () => {
    const path = buildImagePath('$evt1:x', null, 'image/png')
    expect(path).toBe('/tmp/claude-matrix-images/_evt1_x-image.png')
  })

  test('falls back to .bin extension for unknown MIME type', () => {
    const path = buildImagePath('$evt1:x', null, 'application/octet-stream')
    expect(path).toBe('/tmp/claude-matrix-images/_evt1_x-image.bin')
  })

  test('sanitizes filename to prevent path traversal', () => {
    const result = buildImagePath('$evt1:x', '../../etc/passwd.png')
    expect(result).toStartWith('/tmp/claude-matrix-images/')
    // The filename portion should not contain path separators
    const filename = result.split('/tmp/claude-matrix-images/')[1]
    expect(filename).not.toContain('/')
  })
})

describe('shouldForwardEvent', () => {
  const access: Access = {
    allowedUsers: ['@alice:example.com', '@bob:example.com'],
    ackReaction: '👀',
    maxImageSize: DEFAULT_MAX_IMAGE_SIZE,
  }
  const botUserId = '@bot:example.com'

  test('forwards events from allowed users', () => {
    const event: SyncEvent = {
      type: 'text',
      roomId: '!r:x', roomName: 'General',
      sender: '@alice:example.com', eventId: '$1', threadRootId: null, body: 'hi',
    }
    expect(shouldForwardEvent(event, access, botUserId)).toBe(true)
  })

  test('drops events from non-allowed users', () => {
    const event: SyncEvent = {
      type: 'text',
      roomId: '!r:x', roomName: 'General',
      sender: '@mallory:example.com', eventId: '$1', threadRootId: null, body: 'hi',
    }
    expect(shouldForwardEvent(event, access, botUserId)).toBe(false)
  })

  test('drops events from the bot itself', () => {
    const event: SyncEvent = {
      type: 'text',
      roomId: '!r:x', roomName: 'General',
      sender: '@bot:example.com', eventId: '$1', threadRootId: null, body: 'hi',
    }
    expect(shouldForwardEvent(event, access, botUserId)).toBe(false)
  })

  test('drops all events when allowedUsers is empty', () => {
    const emptyAccess: Access = { allowedUsers: [], ackReaction: null, maxImageSize: DEFAULT_MAX_IMAGE_SIZE }
    const event: SyncEvent = {
      type: 'text',
      roomId: '!r:x', roomName: 'General',
      sender: '@alice:example.com', eventId: '$1', threadRootId: null, body: 'hi',
    }
    expect(shouldForwardEvent(event, emptyAccess, botUserId)).toBe(false)
  })

  test('forwards events from allowed rooms when roomIds is set', () => {
    const event: SyncEvent = {
      type: 'text',
      roomId: '!room1:x', roomName: 'General',
      sender: '@alice:example.com', eventId: '$1', threadRootId: null, body: 'hi',
    }
    expect(shouldForwardEvent(event, access, botUserId, ['!room1:x', '!room2:x'])).toBe(true)
  })

  test('drops events from rooms not in roomIds filter', () => {
    const event: SyncEvent = {
      type: 'text',
      roomId: '!other:x', roomName: 'Random',
      sender: '@alice:example.com', eventId: '$1', threadRootId: null, body: 'hi',
    }
    expect(shouldForwardEvent(event, access, botUserId, ['!room1:x'])).toBe(false)
  })

  test('forwards all rooms when roomIds is null', () => {
    const event: SyncEvent = {
      type: 'text',
      roomId: '!any:x', roomName: 'Whatever',
      sender: '@alice:example.com', eventId: '$1', threadRootId: null, body: 'hi',
    }
    expect(shouldForwardEvent(event, access, botUserId, null)).toBe(true)
  })
})

describe('shouldForwardEvent with threaded messages', () => {
  const access: Access = {
    allowedUsers: ['@alice:example.com'],
    ackReaction: null,
    maxImageSize: DEFAULT_MAX_IMAGE_SIZE,
  }
  const botUserId = '@bot:example.com'

  test('forwards threaded messages (thread filtering is handled by sync loop)', () => {
    const event: SyncEvent = {
      type: 'text',
      roomId: '!r:x', roomName: 'General',
      sender: '@alice:example.com', eventId: '$1', threadRootId: '$root1', body: 'hi',
    }
    expect(shouldForwardEvent(event, access, botUserId)).toBe(true)
  })

  test('forwards non-threaded messages from allowed users', () => {
    const event: SyncEvent = {
      type: 'text',
      roomId: '!r:x', roomName: 'General',
      sender: '@alice:example.com', eventId: '$1', threadRootId: null, body: 'hi',
    }
    expect(shouldForwardEvent(event, access, botUserId)).toBe(true)
  })
})

describe('shouldAutoJoin', () => {
  const access: Access = {
    allowedUsers: ['@alice:example.com'],
    ackReaction: null,
    maxImageSize: DEFAULT_MAX_IMAGE_SIZE,
  }

  test('joins when inviter is in allowedUsers', () => {
    expect(shouldAutoJoin({ roomId: '!r:x', inviter: '@alice:example.com' }, access)).toBe(true)
  })

  test('ignores when inviter is not in allowedUsers', () => {
    expect(shouldAutoJoin({ roomId: '!r:x', inviter: '@mallory:example.com' }, access)).toBe(false)
  })

  test('joins when room is in roomIds filter', () => {
    expect(shouldAutoJoin({ roomId: '!r:x', inviter: '@alice:example.com' }, access, ['!r:x'])).toBe(true)
  })

  test('ignores when room is not in roomIds filter', () => {
    expect(shouldAutoJoin({ roomId: '!other:x', inviter: '@alice:example.com' }, access, ['!r:x'])).toBe(false)
  })

  test('joins any room when roomIds is null', () => {
    expect(shouldAutoJoin({ roomId: '!any:x', inviter: '@alice:example.com' }, access, null)).toBe(true)
  })
})

describe('downloadImage', () => {
  const config: Config = {
    homeserverUrl: 'https://matrix.example.com',
    accessToken: 'test-token',
    botUserId: '@bot:example.com',
    roomIds: null,
    threadProject: null,
    threadRootRoomId: null,
  }
  const access: Access = {
    allowedUsers: [],
    ackReaction: null,
    maxImageSize: 1024, // 1KB for testing
  }
  const imageEvent: ImageEvent = {
    type: 'image',
    roomId: '!r:x',
    roomName: 'General',
    sender: '@alice:x',
    eventId: '$test-img-evt',
    threadRootId: null,
    body: 'photo.png',
    mxcUrl: 'mxc://example.com/abc123',
    mimeType: 'image/png',
    size: 100,
    filename: 'photo.png',
  }

  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    trackedImages.clear()
    const dir = '/tmp/claude-matrix-images'
    if (existsSync(dir)) rmSync(dir, { recursive: true })
  })

  test('downloads image and returns path on success', async () => {
    const imageData = new Uint8Array(100).fill(0xFF)
    global.fetch = async () => new Response(imageData, {
      status: 200,
      headers: { 'Content-Length': '100' },
    })

    const result = await downloadImage(config, access, imageEvent)
    expect(result.imagePath).toBeTruthy()
    expect(result.imagePath).toContain('photo.png')
    expect(result.content).toContain('[Image: photo.png')
    expect(result.content).toContain('Use the Read tool')
    expect(existsSync(result.imagePath!)).toBe(true)
  })

  test('rejects when Content-Length exceeds maxImageSize', async () => {
    global.fetch = async () => new Response('', {
      status: 200,
      headers: { 'Content-Length': '2048' },
    })

    const result = await downloadImage(config, access, imageEvent)
    expect(result.imagePath).toBeNull()
    expect(result.content).toContain('exceeds size limit')
  })

  test('returns fallback on fetch error', async () => {
    global.fetch = async () => { throw new Error('Network error') }

    const result = await downloadImage(config, access, imageEvent)
    expect(result.imagePath).toBeNull()
    expect(result.content).toContain('Image download failed')
    expect(result.content).toContain('Network error')
  })

  test('returns fallback on non-200 response', async () => {
    global.fetch = async () => new Response('Not Found', { status: 404 })

    const result = await downloadImage(config, access, imageEvent)
    expect(result.imagePath).toBeNull()
    expect(result.content).toContain('Image download failed')
  })

  test('returns fallback on timeout', async () => {
    global.fetch = async () => {
      const err = new Error('timed out')
      err.name = 'TimeoutError'
      throw err
    }

    const result = await downloadImage(config, access, imageEvent)
    expect(result.imagePath).toBeNull()
    expect(result.content).toContain('timed out')
  })

  test('handles null filename by deriving from MIME type', async () => {
    const noFilenameEvent: ImageEvent = { ...imageEvent, filename: null }
    const imageData = new Uint8Array(50).fill(0xFF)
    global.fetch = async () => new Response(imageData, {
      status: 200,
      headers: { 'Content-Length': '50' },
    })

    const result = await downloadImage(config, access, noFilenameEvent)
    expect(result.imagePath).toContain('image.png')
  })

  test('skips download when event.size exceeds maxImageSize', async () => {
    const oversizedEvent: ImageEvent = { ...imageEvent, size: 2048 }
    global.fetch = async () => { throw new Error('fetch should not be called') }

    const result = await downloadImage(config, access, oversizedEvent)
    expect(result.imagePath).toBeNull()
    expect(result.content).toContain('exceeds size limit')
  })

  test('aborts streaming download when body exceeds maxImageSize', async () => {
    const largeData = new Uint8Array(2048).fill(0xFF)
    global.fetch = async () => new Response(largeData, {
      status: 200,
      // No Content-Length header
    })

    const result = await downloadImage(config, access, imageEvent)
    expect(result.imagePath).toBeNull()
    expect(result.content).toContain('exceeds size limit')
  })
})

describe('scheduleImageCleanup', () => {
  const testDir = '/tmp/claude-matrix-images-test'
  const testFile = `${testDir}/cleanup-test.png`

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    writeFileSync(testFile, 'test')
  })

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true })
  })

  test('deletes file after delay', async () => {
    expect(existsSync(testFile)).toBe(true)
    trackedImages.add(testFile)
    scheduleImageCleanup(testFile, 50)
    await new Promise((r) => setTimeout(r, 100))
    expect(existsSync(testFile)).toBe(false)
    expect(trackedImages.has(testFile)).toBe(false)
  })

  test('does not throw when file is already gone', async () => {
    rmSync(testFile)
    trackedImages.add(testFile)
    scheduleImageCleanup(testFile, 50)
    await new Promise((r) => setTimeout(r, 100))
    expect(trackedImages.has(testFile)).toBe(false)
  })
})

describe('thread root persistence', () => {
  const testDir = '/tmp/test-matrix-threads'
  const threadsFile = `${testDir}/threads.json`

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true })
  })

  test('returns empty map when threads.json does not exist', () => {
    const map = loadThreadRoots(threadsFile)
    expect(map.size).toBe(0)
  })

  test('saves and loads thread root for room+project', () => {
    saveThreadRoot(threadsFile, '!room:x', 'my-project', '$evt1')
    const map = loadThreadRoots(threadsFile)
    expect(map.get('!room:x:my-project')).toBe('$evt1')
  })

  test('preserves existing entries when saving new one', () => {
    saveThreadRoot(threadsFile, '!room:x', 'project-a', '$evt1')
    saveThreadRoot(threadsFile, '!room:x', 'project-b', '$evt2')
    const map = loadThreadRoots(threadsFile)
    expect(map.get('!room:x:project-a')).toBe('$evt1')
    expect(map.get('!room:x:project-b')).toBe('$evt2')
  })

  test('overwrites existing entry for same room+project', () => {
    saveThreadRoot(threadsFile, '!room:x', 'my-project', '$evt1')
    saveThreadRoot(threadsFile, '!room:x', 'my-project', '$evt2')
    const map = loadThreadRoots(threadsFile)
    expect(map.get('!room:x:my-project')).toBe('$evt2')
    expect(map.size).toBe(1)
  })

  test('returns empty map on malformed JSON', () => {
    mkdirSync(testDir, { recursive: true })
    writeFileSync(threadsFile, '{broken')
    const map = loadThreadRoots(threadsFile)
    expect(map.size).toBe(0)
  })
})

describe('parseSyncEvents thread support', () => {
  test('extracts threadRootId from threaded message', () => {
    const syncResponse = {
      rooms: {
        join: {
          '!r:x': {
            timeline: {
              events: [{
                type: 'm.room.message',
                sender: '@a:x',
                event_id: '$msg1',
                content: {
                  msgtype: 'm.text',
                  body: 'reply in thread',
                  'm.relates_to': { rel_type: 'm.thread', event_id: '$root1' },
                },
              }],
            },
            state: { events: [] },
          },
        },
      },
    }
    const events = parseSyncEvents(syncResponse)
    expect(events).toHaveLength(1)
    expect(events[0].threadRootId).toBe('$root1')
  })

  test('sets threadRootId to null for non-threaded messages', () => {
    const syncResponse = {
      rooms: {
        join: {
          '!r:x': {
            timeline: {
              events: [{
                type: 'm.room.message',
                sender: '@a:x',
                event_id: '$msg1',
                content: { msgtype: 'm.text', body: 'plain message' },
              }],
            },
            state: { events: [] },
          },
        },
      },
    }
    const events = parseSyncEvents(syncResponse)
    expect(events).toHaveLength(1)
    expect(events[0].threadRootId).toBeNull()
  })

  test('extracts threadRootId from threaded image message', () => {
    const syncResponse = {
      rooms: {
        join: {
          '!r:x': {
            timeline: {
              events: [{
                type: 'm.room.message',
                sender: '@a:x',
                event_id: '$msg1',
                content: {
                  msgtype: 'm.image',
                  body: 'photo.jpg',
                  url: 'mxc://example.com/abc123',
                  filename: 'photo.jpg',
                  info: { mimetype: 'image/jpeg', size: 12345 },
                  'm.relates_to': { rel_type: 'm.thread', event_id: '$root1' },
                },
              }],
            },
            state: { events: [] },
          },
        },
      },
    }
    const events = parseSyncEvents(syncResponse)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('image')
    expect(events[0].threadRootId).toBe('$root1')
  })
})

describe('cleanupAllImages', () => {
  const testDir = '/tmp/claude-matrix-images-cleanup'

  afterEach(() => {
    trackedImages.clear()
    if (existsSync(testDir)) rmSync(testDir, { recursive: true })
  })

  test('removes all tracked files and clears the set', () => {
    mkdirSync(testDir, { recursive: true })
    const file1 = `${testDir}/a.png`
    const file2 = `${testDir}/b.png`
    writeFileSync(file1, 'a')
    writeFileSync(file2, 'b')
    trackedImages.add(file1)
    trackedImages.add(file2)

    cleanupAllImages()

    expect(existsSync(file1)).toBe(false)
    expect(existsSync(file2)).toBe(false)
    expect(trackedImages.size).toBe(0)
  })

  test('handles already-deleted files without throwing', () => {
    trackedImages.add('/tmp/nonexistent-image.png')
    cleanupAllImages()
    expect(trackedImages.size).toBe(0)
  })
})

// ── Permission Relay ──────────────────────────────────

const PROMPT_EVENT = '$prompt-evt:x'
const REQUEST_ID = 'abcde'
const BOT = '@bot:x'

function makeReaction(overrides: Partial<ReactionEvent> = {}): ReactionEvent {
  return {
    roomId: '!r:x',
    roomName: 'r',
    sender: '@alice:x',
    eventId: '$reaction-evt:x',
    targetEventId: PROMPT_EVENT,
    emoji: ALLOW_EMOJI,
    ...overrides,
  }
}

const baseConfig: Config = {
  homeserverUrl: 'https://x',
  accessToken: 't',
  botUserId: BOT,
  roomIds: null,
  threadProject: null,
  threadRootRoomId: null,
}

const baseAccess: Access = {
  allowedUsers: ['@alice:x'],
  ackReaction: null,
  maxImageSize: DEFAULT_MAX_IMAGE_SIZE,
}

interface RecordedNotification {
  method: string
  params: any
}

function mockMcp(): { mcp: any; calls: RecordedNotification[] } {
  const calls: RecordedNotification[] = []
  return {
    calls,
    mcp: { notification: async (n: RecordedNotification) => { calls.push(n) } },
  }
}

describe('classifyVerdict', () => {
  test('allow on ✅', () => { expect(classifyVerdict(ALLOW_EMOJI)).toBe('allow') })
  test('deny on ❌', () => { expect(classifyVerdict(DENY_EMOJI)).toBe('deny') })
  test('null on anything else', () => {
    expect(classifyVerdict('👍')).toBeNull()
    expect(classifyVerdict('👎')).toBeNull()
    expect(classifyVerdict('🎉')).toBeNull()
    expect(classifyVerdict('')).toBeNull()
  })
})

describe('parseSyncReactions', () => {
  test('extracts annotation reactions with sender, key, target', () => {
    const data = {
      rooms: {
        join: {
          '!r:x': {
            timeline: {
              events: [{
                type: 'm.reaction',
                sender: '@alice:x',
                event_id: '$rx',
                content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: PROMPT_EVENT, key: ALLOW_EMOJI } },
              }],
            },
          },
        },
      },
    }
    const reactions = parseSyncReactions(data)
    expect(reactions).toHaveLength(1)
    expect(reactions[0]).toMatchObject({
      roomId: '!r:x',
      sender: '@alice:x',
      eventId: '$rx',
      targetEventId: PROMPT_EVENT,
      emoji: ALLOW_EMOJI,
    })
  })

  test('skips non-annotation rel_types', () => {
    const data = {
      rooms: {
        join: {
          '!r:x': {
            timeline: {
              events: [{
                type: 'm.reaction',
                sender: '@a:x',
                event_id: '$rx',
                content: { 'm.relates_to': { rel_type: 'm.replace', event_id: PROMPT_EVENT, key: ALLOW_EMOJI } },
              }],
            },
          },
        },
      },
    }
    expect(parseSyncReactions(data)).toHaveLength(0)
  })

  test('skips reactions missing m.relates_to', () => {
    const data = {
      rooms: {
        join: {
          '!r:x': {
            timeline: {
              events: [{ type: 'm.reaction', sender: '@a:x', event_id: '$rx', content: {} }],
            },
          },
        },
      },
    }
    expect(parseSyncReactions(data)).toHaveLength(0)
  })

  test('ignores non-reaction events', () => {
    const data = {
      rooms: {
        join: {
          '!r:x': {
            timeline: {
              events: [{ type: 'm.room.message', sender: '@a:x', event_id: '$m', content: { msgtype: 'm.text', body: 'hi' } }],
            },
          },
        },
      },
    }
    expect(parseSyncReactions(data)).toHaveLength(0)
  })
})

describe('shouldHonorReaction', () => {
  test('rejects bot reactions', () => {
    expect(shouldHonorReaction(makeReaction({ sender: BOT }), baseAccess, BOT)).toBe(false)
  })
  test('rejects senders not in allowlist', () => {
    expect(shouldHonorReaction(makeReaction({ sender: '@stranger:x' }), baseAccess, BOT)).toBe(false)
  })
  test('accepts allowlisted senders', () => {
    expect(shouldHonorReaction(makeReaction({ sender: '@alice:x' }), baseAccess, BOT)).toBe(true)
  })
  test('rejects when room is not in roomIds filter', () => {
    expect(shouldHonorReaction(makeReaction({ roomId: '!other:x' }), baseAccess, BOT, ['!r:x'])).toBe(false)
  })
  test('accepts when room is in roomIds filter', () => {
    expect(shouldHonorReaction(makeReaction({ roomId: '!r:x' }), baseAccess, BOT, ['!r:x'])).toBe(true)
  })
})

describe('pickPermissionRoom', () => {
  test('returns thread root in thread mode', () => {
    const cfg: Config = { ...baseConfig, threadRootRoomId: '!thread:x', threadProject: 'p' }
    expect(pickPermissionRoom(cfg, { roomId: '!ignored:x' })).toBe('!thread:x')
  })
  test('falls back to last active room in room mode', () => {
    expect(pickPermissionRoom(baseConfig, { roomId: '!last:x' })).toBe('!last:x')
  })
  test('falls back to first configured room when no last active', () => {
    const cfg: Config = { ...baseConfig, roomIds: ['!first:x', '!second:x'] }
    expect(pickPermissionRoom(cfg, { roomId: null })).toBe('!first:x')
  })
  test('returns null when no info', () => {
    expect(pickPermissionRoom(baseConfig, { roomId: null })).toBeNull()
  })
})

describe('buildPermissionPromptText', () => {
  test('includes request id, tool, description, preview, instruction', () => {
    const text = buildPermissionPromptText({
      request_id: REQUEST_ID,
      tool_name: 'Bash',
      description: 'list files',
      input_preview: 'ls -la',
    })
    expect(text).toContain(REQUEST_ID)
    expect(text).toContain('Bash')
    expect(text).toContain('list files')
    expect(text).toContain('ls -la')
    expect(text).toContain(ALLOW_EMOJI)
    expect(text).toContain(DENY_EMOJI)
  })

  test('omits preview block when input_preview is empty', () => {
    const text = buildPermissionPromptText({
      request_id: REQUEST_ID,
      tool_name: 'Bash',
      description: 'd',
      input_preview: '',
    })
    expect(text).not.toContain('```')
  })
})

describe('expirePendingPermissions', () => {
  beforeEach(() => { pendingPermissions.clear() })
  afterEach(() => { pendingPermissions.clear() })

  test('removes entries past expiresAt', () => {
    pendingPermissions.set('$old', { requestId: 'old1a', expiresAt: 100 })
    pendingPermissions.set('$new', { requestId: 'new1a', expiresAt: 10_000 })
    expirePendingPermissions(500)
    expect(pendingPermissions.has('$old')).toBe(false)
    expect(pendingPermissions.has('$new')).toBe(true)
  })
})

describe('processReactions', () => {
  beforeEach(() => {
    pendingPermissions.clear()
    lastActiveRoomState.roomId = null
  })
  afterEach(() => {
    pendingPermissions.clear()
    lastActiveRoomState.roomId = null
  })

  test('emits allow verdict when allowed user reacts ✅', async () => {
    pendingPermissions.set(PROMPT_EVENT, { requestId: REQUEST_ID, expiresAt: Date.now() + 60000 })
    const { mcp, calls } = mockMcp()
    await processReactions([makeReaction()], baseConfig, baseAccess, mcp)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      method: 'notifications/claude/channel/permission',
      params: { request_id: REQUEST_ID, behavior: 'allow' },
    })
    expect(pendingPermissions.has(PROMPT_EVENT)).toBe(false)
  })

  test('emits deny verdict on ❌', async () => {
    pendingPermissions.set(PROMPT_EVENT, { requestId: REQUEST_ID, expiresAt: Date.now() + 60000 })
    const { mcp, calls } = mockMcp()
    await processReactions([makeReaction({ emoji: DENY_EMOJI })], baseConfig, baseAccess, mcp)
    expect(calls[0]?.params).toEqual({ request_id: REQUEST_ID, behavior: 'deny' })
  })

  test('ignores reactions on unknown targets', async () => {
    const { mcp, calls } = mockMcp()
    await processReactions([makeReaction({ targetEventId: '$unknown' })], baseConfig, baseAccess, mcp)
    expect(calls).toHaveLength(0)
  })

  test('ignores reactions from bot itself', async () => {
    pendingPermissions.set(PROMPT_EVENT, { requestId: REQUEST_ID, expiresAt: Date.now() + 60000 })
    const { mcp, calls } = mockMcp()
    await processReactions([makeReaction({ sender: BOT })], baseConfig, baseAccess, mcp)
    expect(calls).toHaveLength(0)
    expect(pendingPermissions.has(PROMPT_EVENT)).toBe(true)
  })

  test('ignores reactions from non-allowlisted users', async () => {
    pendingPermissions.set(PROMPT_EVENT, { requestId: REQUEST_ID, expiresAt: Date.now() + 60000 })
    const { mcp, calls } = mockMcp()
    await processReactions([makeReaction({ sender: '@stranger:x' })], baseConfig, baseAccess, mcp)
    expect(calls).toHaveLength(0)
    expect(pendingPermissions.has(PROMPT_EVENT)).toBe(true)
  })

  test('ignores unsupported emojis but keeps entry pending', async () => {
    pendingPermissions.set(PROMPT_EVENT, { requestId: REQUEST_ID, expiresAt: Date.now() + 60000 })
    const { mcp, calls } = mockMcp()
    await processReactions([makeReaction({ emoji: '👍' })], baseConfig, baseAccess, mcp)
    expect(calls).toHaveLength(0)
    expect(pendingPermissions.has(PROMPT_EVENT)).toBe(true)
  })

  test('expires stale entries before processing', async () => {
    pendingPermissions.set(PROMPT_EVENT, { requestId: REQUEST_ID, expiresAt: Date.now() - 1 })
    const { mcp, calls } = mockMcp()
    await processReactions([makeReaction()], baseConfig, baseAccess, mcp)
    expect(calls).toHaveLength(0)
    expect(pendingPermissions.has(PROMPT_EVENT)).toBe(false)
  })

  test('first matching reaction wins; subsequent ones drop', async () => {
    pendingPermissions.set(PROMPT_EVENT, { requestId: REQUEST_ID, expiresAt: Date.now() + 60000 })
    const { mcp, calls } = mockMcp()
    await processReactions(
      [makeReaction({ emoji: ALLOW_EMOJI }), makeReaction({ emoji: DENY_EMOJI, eventId: '$rx2' })],
      baseConfig,
      baseAccess,
      mcp,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.params.behavior).toBe('allow')
  })
})

// ── Typing Coordinator ────────────────────────────────

import {
  TypingCoordinator,
  LocalTypingController,
  ClientTypingController,
  type SendTyping,
} from './server'
import type { WireFrame } from './mux'

function typingRecorder(): { send: SendTyping; calls: Array<{ roomId: string; typing: boolean }> } {
  const calls: Array<{ roomId: string; typing: boolean }> = []
  return { calls, send: async (roomId, typing) => { calls.push({ roomId, typing }) } }
}

// Long-lived timers so they never fire during a single synchronous test.
const inert = { refreshMs: 60_000, maxMs: 60_000 }

describe('TypingCoordinator', () => {
  test('first lease drives typing:true, last release drives typing:false', () => {
    const { send, calls } = typingRecorder()
    const c = new TypingCoordinator(send, inert)
    c.acquire('local', '!r:x')
    expect(calls).toEqual([{ roomId: '!r:x', typing: true }])
    expect(c.isTyping('!r:x')).toBe(true)
    c.release('local', '!r:x')
    expect(calls).toEqual([
      { roomId: '!r:x', typing: true },
      { roomId: '!r:x', typing: false },
    ])
    expect(c.isTyping('!r:x')).toBe(false)
  })

  test('one holder releasing does not clear another holder still in the room', () => {
    // Codex Finding 1: concurrent sessions sharing a room must not stop each other's indicator.
    const { send, calls } = typingRecorder()
    const c = new TypingCoordinator(send, inert)
    c.acquire('sessionA', '!shared:x')
    c.acquire('sessionB', '!shared:x')
    // Only one typing:true for the room despite two holders.
    expect(calls).toEqual([{ roomId: '!shared:x', typing: true }])

    c.release('sessionA', '!shared:x') // A replied first; B is still working
    expect(c.isTyping('!shared:x')).toBe(true)
    expect(calls.filter((x) => !x.typing)).toHaveLength(0) // no typing:false yet

    c.release('sessionB', '!shared:x') // now the last holder leaves
    expect(c.isTyping('!shared:x')).toBe(false)
    expect(calls).toContainEqual({ roomId: '!shared:x', typing: false })
  })

  test('acquire is idempotent per (holder, room)', () => {
    const { send, calls } = typingRecorder()
    const c = new TypingCoordinator(send, inert)
    c.acquire('local', '!r:x')
    c.acquire('local', '!r:x')
    c.acquire('local', '!r:x')
    expect(calls.filter((x) => x.typing)).toHaveLength(1)
    c.stopAll()
  })

  test('release is a no-op when the holder has no lease', () => {
    const { send, calls } = typingRecorder()
    const c = new TypingCoordinator(send, inert)
    c.release('ghost', '!r:x')
    expect(calls).toHaveLength(0)
  })

  test('releaseAll drops only that holder, leaving rooms others still hold', () => {
    const { send } = typingRecorder()
    const c = new TypingCoordinator(send, inert)
    c.acquire('A', '!one:x')
    c.acquire('A', '!two:x')
    c.acquire('B', '!one:x')

    c.releaseAll('A')
    expect(c.isTyping('!one:x')).toBe(true)  // B still holds !one
    expect(c.isTyping('!two:x')).toBe(false) // only A held !two
    c.stopAll()
  })

  test('rooms are tracked independently', () => {
    const { send } = typingRecorder()
    const c = new TypingCoordinator(send, inert)
    c.acquire('local', '!a:x')
    c.acquire('local', '!b:x')
    c.release('local', '!a:x')
    expect(c.isTyping('!a:x')).toBe(false)
    expect(c.isTyping('!b:x')).toBe(true)
    c.stopAll()
  })

  test('stopAll clears every room and emits typing:false for active ones', () => {
    const { send, calls } = typingRecorder()
    const c = new TypingCoordinator(send, inert)
    c.acquire('local', '!a:x')
    c.acquire('local', '!b:x')
    c.stopAll()
    expect(c.isTyping('!a:x')).toBe(false)
    expect(c.isTyping('!b:x')).toBe(false)
    expect(calls.filter((x) => !x.typing).map((x) => x.roomId).sort()).toEqual(['!a:x', '!b:x'])
  })

  test('refresh timer re-asserts typing while a room is held', async () => {
    const { send, calls } = typingRecorder()
    const c = new TypingCoordinator(send, { refreshMs: 20, maxMs: 60_000 })
    c.acquire('local', '!r:x')
    await new Promise((r) => setTimeout(r, 70))
    c.stopAll()
    expect(calls.filter((x) => x.typing).length).toBeGreaterThanOrEqual(3)
  })

  test('per-lease safety timeout releases a stuck lease', async () => {
    const { send, calls } = typingRecorder()
    const c = new TypingCoordinator(send, { refreshMs: 60_000, maxMs: 30 })
    c.acquire('local', '!r:x')
    await new Promise((r) => setTimeout(r, 60))
    expect(c.isTyping('!r:x')).toBe(false)
    expect(calls).toContainEqual({ roomId: '!r:x', typing: false })
  })

  test('re-acquire pushes the safety deadline out instead of stacking', async () => {
    const { send } = typingRecorder()
    const c = new TypingCoordinator(send, { refreshMs: 60_000, maxMs: 40 })
    c.acquire('local', '!r:x')
    await new Promise((r) => setTimeout(r, 25))
    c.acquire('local', '!r:x') // renews the lease for another 40ms
    await new Promise((r) => setTimeout(r, 25)) // 50ms in, original deadline passed but renewed
    expect(c.isTyping('!r:x')).toBe(true)
    await new Promise((r) => setTimeout(r, 30)) // past the renewed deadline
    expect(c.isTyping('!r:x')).toBe(false)
  })
})

describe('LocalTypingController', () => {
  test('start/stop drive the coordinator under a single holder and track active rooms', () => {
    const { send, calls } = typingRecorder()
    const c = new TypingCoordinator(send, inert)
    const ctrl = new LocalTypingController(c)
    ctrl.start('!r:x')
    expect(ctrl.activeRooms()).toEqual(['!r:x'])
    expect(c.isTyping('!r:x')).toBe(true)
    ctrl.stop('!r:x')
    expect(ctrl.activeRooms()).toEqual([])
    expect(calls).toEqual([
      { roomId: '!r:x', typing: true },
      { roomId: '!r:x', typing: false },
    ])
  })

  test('two controllers on one coordinator refcount the same room', () => {
    const { send, calls } = typingRecorder()
    const c = new TypingCoordinator(send, inert)
    const owner = new LocalTypingController(c, 'local')
    const client = new LocalTypingController(c, 'c0')
    owner.start('!shared:x')
    client.start('!shared:x')
    owner.stop('!shared:x')
    expect(c.isTyping('!shared:x')).toBe(true) // client still holds it
    client.stop('!shared:x')
    expect(c.isTyping('!shared:x')).toBe(false)
    expect(calls.filter((x) => x.typing)).toHaveLength(1)
    expect(calls.filter((x) => !x.typing)).toHaveLength(1)
  })

  test('resync re-acquires all held rooms', () => {
    const { send } = typingRecorder()
    const c = new TypingCoordinator(send, inert)
    const ctrl = new LocalTypingController(c)
    ctrl.start('!a:x')
    ctrl.start('!b:x')
    c.stopAll() // simulate the coordinator being replaced under the controller
    expect(c.isTyping('!a:x')).toBe(false)
    ctrl.resync()
    expect(c.isTyping('!a:x')).toBe(true)
    expect(c.isTyping('!b:x')).toBe(true)
    c.stopAll()
  })
})

describe('ClientTypingController', () => {
  function linkRecorder(): { link: { send: (f: WireFrame) => void }; frames: WireFrame[] } {
    const frames: WireFrame[] = []
    return { frames, link: { send: (f) => frames.push(f) } }
  }

  test('start and stop emit typing lease frames', () => {
    const { link, frames } = linkRecorder()
    const ctrl = new ClientTypingController(link)
    ctrl.start('!r:x')
    ctrl.stop('!r:x')
    expect(frames).toEqual([
      { v: 1, type: 'typing', roomId: '!r:x', active: true },
      { v: 1, type: 'typing', roomId: '!r:x', active: false },
    ])
    expect(ctrl.activeRooms()).toEqual([])
  })

  test('resync re-sends an active lease for every held room', () => {
    const { link, frames } = linkRecorder()
    const ctrl = new ClientTypingController(link)
    ctrl.start('!a:x')
    ctrl.start('!b:x')
    frames.length = 0 // ignore the initial acquires
    ctrl.resync()
    expect(frames).toEqual([
      { v: 1, type: 'typing', roomId: '!a:x', active: true },
      { v: 1, type: 'typing', roomId: '!b:x', active: true },
    ])
  })
})
