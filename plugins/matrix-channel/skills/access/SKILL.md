---
name: access
description: Manage the Matrix channel sender allowlist. Use when the user wants to add, remove, or list allowed Matrix users.
---

# Manage Matrix Access Control

Manage which Matrix users can send messages to Claude through this channel.

## Usage

Parse the subcommand and arguments from "$ARGUMENTS":
- `/matrix:access add <user_id>` — Add a Matrix user ID to the allowlist
- `/matrix:access remove <user_id>` — Remove a Matrix user ID from the allowlist
- `/matrix:access list` — Show the current allowlist

## Access File

The allowlist is stored at `~/.claude/channels/matrix/access.json` with this format:

```json
{
  "allowedUsers": ["@user:example.com"],
  "ackReaction": "👀"
}
```

## Steps

### For `add`:
1. Read the existing `access.json` (or start with `{"allowedUsers": [], "ackReaction": "👀"}` if it doesn't exist)
2. Add the user ID to `allowedUsers` if not already present
3. Write the updated file back
4. Confirm the user was added

### For `remove`:
1. Read the existing `access.json`
2. Remove the user ID from `allowedUsers`
3. Write the updated file back
4. Confirm the user was removed

### For `list`:
1. Read the existing `access.json`
2. Display the list of allowed users and the current ack reaction setting

### Tools
Use `jq` to read and modify the JSON file. Example for adding a user:
```bash
jq --arg user "<user_id>" '.allowedUsers += [$user] | .allowedUsers |= unique' ~/.claude/channels/matrix/access.json > /tmp/access.json && mv /tmp/access.json ~/.claude/channels/matrix/access.json
```
