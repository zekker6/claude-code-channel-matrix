---
name: configure
description: Configure Matrix channel credentials (homeserver URL, access token, bot user ID). Use when the user wants to set up or update their Matrix connection.
---

# Configure Matrix Channel

Set up the Matrix bot credentials for the channel plugin.

## Usage

The user provides: `/matrix:configure <homeserver_url> <access_token>`

Parse the arguments from "$ARGUMENTS". Extract the homeserver URL (first argument) and access token (second argument).

If arguments are missing, ask the user to provide them:
- `homeserver_url`: The Matrix homeserver URL (e.g., `https://matrix.example.com`)
- `access_token`: A Matrix access token for the bot account

## Validation

**The homeserver URL MUST include the protocol scheme (`https://` or `http://`).** If the user provides a URL without a scheme (e.g., `matrix.example.com`), automatically prepend `https://`. Always strip any trailing slashes.

## Steps

1. Create the directory `~/.claude/channels/matrix/` if it doesn't exist:
   ```bash
   mkdir -p ~/.claude/channels/matrix
   ```

2. Validate the homeserver URL has a protocol scheme. If it does not start with `https://` or `http://`, prepend `https://`.

3. Ask the user for their bot's Matrix user ID (e.g., `@claude-bot:example.com`)

4. Write the `.env` file at `~/.claude/channels/matrix/.env`:
   ```
   MATRIX_HOMESERVER_URL=<homeserver_url>
   MATRIX_ACCESS_TOKEN=<access_token>
   MATRIX_BOT_USER_ID=<bot_user_id>
   ```

4. Confirm the configuration was saved.

5. Remind the user to set up their allowlist with `/matrix:access add <user_id>` if they haven't already.
