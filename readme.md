# claude-code-channel-matrix

A [Claude Code channel plugin](https://code.claude.com/docs/en/channels-reference) that connects Claude to Matrix rooms. Messages from allowed Matrix users are forwarded to Claude, and Claude can reply and react directly in Matrix.

## How it works

The plugin runs an MCP server that maintains a long-polling sync loop against the Matrix Client-Server API. On each sync cycle it:

- Forwards incoming `m.text` and `m.image` messages from allowed senders to Claude as channel notifications
- Auto-joins rooms when invited by an allowed user
- Optionally reacts to forwarded messages with a configurable acknowledgment emoji
- Supports per-project threading — each Claude Code session gets its own thread in a room

Claude receives messages tagged with room ID, room name, sender, and event ID, and can respond using two tools:

- **reply** — send a plain text or HTML message to a Matrix room
- **react** — react to a specific message with an emoji

## Prerequisites

You need a Matrix bot account with an access token. To create one:

1. Register a new account on your Matrix homeserver (e.g. via Element or `curl`)
2. Obtain an access token
3. Note down the bot's full user ID (e.g. `@claude-bot:example.com`)

## Installation

Add the marketplace and install the plugin from within Claude Code:

```
/plugin marketplace add zekker6/claude-code-channel-matrix
/plugin install matrix@claude-code-channel-matrix
```

Channel plugins that are not on the official approved allowlist require the `--dangerously-load-development-channels` flag to run:

```bash
claude --dangerously-load-development-channels plugin:matrix@claude-code-channel-matrix
```

> The plugin was submitted to official marketplace to review, instruction will be updated if it will be approved.

## Configuration

Run the configure slash command inside Claude Code:

```
/matrix:configure <homeserver_url> <access_token>
```

You will be prompted for the bot's Matrix user ID. This writes credentials to `~/.claude/channels/matrix/.env`:

```
MATRIX_HOMESERVER_URL=https://matrix.example.com
MATRIX_ACCESS_TOKEN=syt_...
MATRIX_BOT_USER_ID=@claude-bot:example.com
```

Alternatively, set these environment variables directly or create the `.env` file manually.

## Access control

Only messages from explicitly allowed Matrix users are forwarded to Claude. Manage the allowlist with:

```
/matrix:access add @alice:example.com
/matrix:access remove @alice:example.com
/matrix:access list
```

The allowlist is stored at `~/.claude/channels/matrix/access.json`:

```json
{
  "allowedUsers": ["@alice:example.com"],
  "ackReaction": "👀"
}
```

Set `ackReaction` to an emoji string to have the bot react to every forwarded message, or `null` to disable.

## Per-project threading

When threading is enabled, each Claude Code session creates its own thread in the designated anchor room. This keeps conversations organized — replies from different projects don't mix in the room timeline.

**Thread mode and room mode are mutually exclusive.** Use `MATRIX_ROOM_IDS` for multi-room listening without threads, or `MATRIX_THREAD_ROOT_ROOM_ID` for single-room threading.

### Enabling threads

Add to your `.env` file or set as environment variables:

```
MATRIX_THREADS=true
MATRIX_THREAD_ROOT_ROOM_ID=!your-room-id:example.com
```

The project name defaults to the basename of Claude Code's working directory. To override it:

```
MATRIX_THREADS=true
MATRIX_THREAD_ROOT_ROOM_ID=!your-room-id:example.com
MATRIX_THREAD_PROJECT=my-project
```

### How it works

1. On startup, the plugin creates a thread root message ("Thread: my-project") in the anchor room
2. In Element (or any thread-aware client), you see the thread and reply within it
3. Claude receives threaded messages and replies inside the thread
4. Non-threaded messages are always ignored when threading is enabled — use the thread

Thread roots are persisted in `~/.claude/channels/matrix/threads.json`, so the same thread is reused across sessions for the same project.

### Multiple projects

If you run Claude Code sessions in different project directories simultaneously, each session creates its own thread in the anchor room. Messages in a project's thread are only forwarded to that project's session.

> **Breaking change:** Previous versions allowed `MATRIX_ROOM_IDS` alongside `MATRIX_THREADS=true`. This is no longer valid — use `MATRIX_THREAD_ROOT_ROOM_ID` instead.

## Optional configuration

### Room filtering

Restrict the plugin to specific rooms:

```
MATRIX_ROOM_IDS=!room1:example.com,!room2:example.com
```

When not set, the plugin listens to all rooms the bot has joined.

### Image size limit

Set the maximum image download size (default 10MB):

```
MATRIX_MAX_IMAGE_SIZE=5242880
```

Or in `access.json`:

```json
{
  "allowedUsers": ["@alice:example.com"],
  "maxImageSize": 5242880
}
```

## Development

Run tests from the plugin directory:

```bash
cd plugins/matrix-channel
bun test
```

For local testing without the marketplace, use `--plugin-dir`:

```bash
claude --plugin-dir ./plugins/matrix-channel --dangerously-load-development-channels plugin:matrix@inline
```

## License

[MIT](LICENSE)
