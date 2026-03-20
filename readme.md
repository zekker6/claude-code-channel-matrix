# claude-code-channel-matrix

A [Claude Code channel plugin](https://code.claude.com/docs/en/channels-reference) that connects Claude to Matrix rooms. Messages from allowed Matrix users are forwarded to Claude, and Claude can reply and react directly in Matrix.

## How it works

The plugin runs an MCP server that maintains a long-polling sync loop against the Matrix Client-Server API. On each sync cycle it:

- Forwards incoming `m.text` messages from allowed senders to Claude as channel notifications
- Auto-joins rooms when invited by an allowed user
- Optionally reacts to forwarded messages with a configurable acknowledgment emoji

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

This applies to all self-published and local channel plugins. To remove this requirement, [submit the plugin to the official marketplace](https://code.claude.com/docs/en/channels-reference#package-as-a-plugin) for security review.

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

## Development

Run tests from the plugin directory:

```bash
cd plugins/matrix-channel
bun test
```

For local testing without the marketplace, use `--plugin-dir`:

```bash
claude --plugin-dir ./plugins/matrix-channel --dangerously-load-development-channels plugin:matrix
```

## License

[MIT](LICENSE)
