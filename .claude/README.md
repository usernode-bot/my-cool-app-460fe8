# `.claude/` — Claude Code settings for this repo

## Why `settings.json` is here

This app is built on **Usernode**, and Usernode has a hosted MCP connector
that Claude and ChatGPT can talk to. Without an allow rule, Claude Code asks
permission on **every** connector call — including read-only ones like
`whoami`, `get_proposal` and `list_requests`. In a Claude Code web session
that grant does not persist, so the prompts come back next session. The
calls that genuinely deserve a confirmation — `submit_work` puts a change to
a group vote — end up buried in that noise and approved by reflex.

`settings.json` allows the read-only connector calls and **nothing else**:

```json
{
  "permissions": {
    "allow": [
      "mcp__usernode__get_*",
      "mcp__usernode__list_*",
      "mcp__usernode__whoami",
      "mcp__Usernode__get_*",
      "mcp__Usernode__list_*",
      "mcp__Usernode__whoami"
    ]
  }
}
```

Deliberately not `mcp__usernode__*`. Usernode also marks its
acting tools `anthropic/requiresUserInteraction`, which forces a prompt no
allow rule can skip — but that needs Claude Code 2.1.199 or later, and older
versions ignore it. A whole-server rule would therefore auto-approve
`submit_work` on an older client. These three entries can only ever match
reads, on every version.

## You will still see one trust dialog

`permissions.allow` rules in a project's `.claude/settings.json` grant
capability, so Claude Code applies them only after you accept the
**workspace trust dialog** for this workspace. Until then it reads the rules
but does not apply them. The dialog lists the rules, so you can review them
before accepting. One reviewable consent instead of dozens of per-call
prompts is the whole trade — and a repo silently granting a connector
permission on your behalf is exactly what that check exists to prevent.

## If you are still being prompted

The server segment of a permission rule is a **literal** — `mcp__*__get_*`
is not a thing — so these rules only match a connector named exactly
`usernode` or `Usernode` — the two spellings the shipped
list covers. Claude.ai's "Add custom connector" dialog takes
whatever **name you type**, and a rule aimed at a different one fails
silently: no error, you just keep getting prompted.

**Read the name off your own tool list rather than trusting this file.** The
tool names you actually see are either `mcp__<server>__whoami` or
`mcp__claude_ai_<server>__whoami` — the prefix differs by surface. Copy the
`<server>` segment you see and edit the rules to match, or reconnect
the connector naming it `usernode` exactly.

## Adding your own rules

This file is yours — add project rules alongside the connector ones. Just
keep the connector entries narrow: never widen them to a whole-server
wildcard, for the version reason above.

To stop the prompts in **every** repo at once rather than one at a time, put
the same rules under `permissions.allow` in your personal
`~/.claude/settings.json`. Usernode's Settings → Connectors page has the
exact block, a copy button, and a field that rewrites the rules for a
connector registered under some other name.
