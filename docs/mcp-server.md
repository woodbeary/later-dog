# later.dog MCP server

The later.dog desktop app includes a local stdio MCP server. It lets another MCP client coordinate your
later.dog team while the desktop app and its harness are running.

## What it can do

- list bots and channels, including their active task and current activity;
- read bounded transcript pages and search local transcripts without returning screenshot pixels;
- create and safely edit bot profiles, channels, and separate task conversations;
- send work to a bot or channel, wait for either conversation to settle or need help, and interrupt its active turn;
- list configured model instances and switch an idle bot to an exact available model.

The v1 server intentionally cannot approve requests, remember permission grants, delete data, import teams,
or change credentials. Those actions stay in the human-facing app. It also lists nine `computer_*` and `decide` tools
that call later.dog Cloud directly with the key this Mac already holds (create, wake, sleep, screenshot, mouse and
keyboard, commands, a viewer link, and Clef decisions). They never touch the team or this server's routes; see
[computer tools](laterdog/computer-tools.md). They cannot delete a computer. They sit outside the local-tools allow-list below, which only governs this server's own routes: they never use the local-control token and call later.dog Cloud with the Mac's computers key.

## From a source checkout

Start later.dog, then configure the MCP client to run:

```json
{
  "mcpServers": {
    "laterdog": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/later.dog", "mcp"]
    }
  }
}
```

Packaged desktop builds make local tools prove they are on the same Mac before they create, change, send, switch,
interrupt, or run anything. Read-only tools work on loopback without any proof. A hosted or shared server with service
loopback trust ([self-hosting](self-hosting.md#loopback-trust-owner-or-service)) needs a session for almost every tool,
reads included.

## Local tools on the same Mac: no pairing

When the desktop app starts, it writes a fresh random token to a private file (mode 0600) in its own folder and hands the
same token to its server:

| System | File |
| --- | --- |
| macOS | `~/Library/Application Support/later.dog/local-control-token` |
| Windows | `%APPDATA%\later.dog\local-control-token` |
| Linux | `$XDG_CONFIG_HOME/later.dog/local-control-token` (else `~/.config/later.dog/local-control-token`) |

`scripts/mcp-server.ts` (the MCP server, including the one bundled in release builds) and `scripts/control-laterdog.ts`
read that file by themselves, so Claude Code, Codex and your own scripts on this Mac just work with no setup. A script
uses the file only if you own it and nobody else can read it (mode 0600, not a symlink; on Windows the folder's own
permissions apply), and sends the token as `X-LaterDog-Local-Tools` only to a loopback address, never while probing ports for the
server, and not at all when `LATERDOG_SERVER_TOKEN` is set (a paired session token wins). Each launch writes a new token,
and the file is removed at quit; a tool that cached an old one gets "token is out of date; restart the tool". Point
`LATERDOG_LOCAL_CONTROL_TOKEN_FILE` at another file to override the location. Your own scripts can read the same file and
send the same header to `http://127.0.0.1:<port>`.

**The token gets nothing unless a route is on an allow-list.** The list is what the two scripts really send, and nothing
more (`LOCAL_TOOLS_ALLOWED_ROUTES` in `server/laterdog/local-tools-scope.ts`). For each route only the listed body fields,
of the listed shapes, are accepted; any other field, nested field or wrong shape is refused. Everything else gets "a dog
must not be able to approve its own work" and needs the desktop app or a paired device.

| Request | Fields the token may send |
| --- | --- |
| `POST /api/bots/:id/messages`, `POST /api/groups/:id/messages` | `text`, `threadId` |
| `POST /api/bots/:id/messages/:id/edit` | `text`, `threadId` |
| `POST /api/bots/:id/interrupt`, `POST /api/groups/:id/interrupt` | `threadId` |
| `POST /api/bots` | `name`, `title`, `description`, `modelSelection`, `requireAvailableModel` |
| `PATCH /api/bots/:id` | `name`, `title`, `description`, `modelSelection`, `requireAvailableModel` |
| `POST /api/groups` | `name`, `memberIds`, `setup` (`bulletin`, `defaultResponder`) |
| `PATCH /api/groups/:id` | `name`, `memberIds`, `bulletin`, `defaultResponder` |
| `POST /api/bots/:id/tasks`, `POST /api/groups/:id/tasks` | `title` |
| `POST /api/bots/:id/tasks/:id`, `POST /api/groups/:id/tasks/:id` (switch) | none |
| `PATCH /api/bots/:id/tasks/:id` | `title`, `modelSelection`, `requireAvailableModel` |
| `PATCH /api/groups/:id/tasks/:id` | `title` |

A `modelSelection` is `instanceId`, `model` and optionally `effort`. Reads need no token on loopback; the reads that
return secrets (the desktop viewer's links and passwords, connector card status) are not on the list, so the token does not
open them. Four tool arguments are refused on purpose: `section` on `create_bot`, `create_channel`, `update_bot_profile` and
`update_channel`, because pack membership gives a dog its peers' reach and the pack's shared computer, so a token can put
nothing in a pack and move nothing between packs.

Messages sent with the token come from your own Mac, so dogs take them as yours:

- **The dog reads them as your message.** Its prompt shows the text as you typed it, and in a room's transcript the
  speaker is you. Every dog and room takes them, Full access included, and a conversation a local tool wrote in can still
  use your Mac. They are stored `via: "api"`, and they do not count as you being at the keyboard, so they cannot answer a
  dog's question card by typing, cannot end a take-over, and do not clear a dog's "nobody is at the keyboard" state.
- **It may edit only messages that a local tool sent.** Editing yours is refused; the edited message keeps `via: "api"`.
- **Its interrupts are recorded as a tool's.** A stop from the token ends a handoff tree with `endedBy: "api"` ("A local
  tool on this Mac stopped this work."), the chip says "stopped by a local tool", and it does not mark the stop as the
  person's for the dog's context.

Any program running as you on this Mac can read that file, a dog's shell included when its mode lets it read your files
and reach the network. That is why the token can only do what the scripts do, why it cannot approve anything, answer a
card or grant a permission, and why those need the desktop app (the owner header never leaves the app) or a paired
device. `server/laterdog/local-tools-scope.test.ts` runs every MCP tool and checks that each change it sends is allowed,
scans the server's source for its routes (over 300) and checks that exactly the allow-list's routes accept the token;
`server/local-tools-token.e2e.test.ts` runs the scripts against a desktop-managed fixture with only the token, and checks that it reaches Full access dogs and rooms, that the dog's real prompt carries the text as yours, the edit limit, the pack refusal and the tool stop on real handlers.

## Pairing a device or an MCP client from outside this Mac

A paired session works from anywhere the server is reachable and can do the refused routes above. To authorize an
external MCP client:

1. In later.dog, open **Settings → Phone → Set up a phone** and reveal the
   one-time pairing code.
2. Exchange it locally (remove spaces from the displayed code):

   ```sh
   curl -X POST http://127.0.0.1:8799/api/auth/pair \
     -H 'content-type: application/json' \
     --data '{"code":"YOUR-CODE","label":"Local MCP client"}'
   ```

   If the desktop selected a fallback port, replace `8799` with the port shown
   in Settings. Copy the returned `token`; the pairing code is single-use.
3. Pin that same port and token in the MCP configuration:

   ```json
   "env": {
     "ELECTRON_RUN_AS_NODE": "1",
     "LATERDOG_SERVER_PORT": "8799",
     "LATERDOG_SERVER_TOKEN": "laterdog_sess_..."
   }
   ```

The paired client appears with phones under **Settings → Phone** and can be
revoked there. Do not share the token or commit it to a repository.

## From the installed desktop app

Release builds bundle `server/mcp-server.js` and can run it with Electron's embedded Node runtime, so users do
not need Node.js or pnpm installed.

macOS example:

```json
{
  "mcpServers": {
    "laterdog": {
      "command": "/Applications/later.dog.app/Contents/MacOS/later.dog",
      "args": ["/Applications/later.dog.app/Contents/Resources/server/mcp-server.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

On Windows, use the installed `later.dog.exe` as `command`, the adjacent
`resources\\server\\mcp-server.js` as the argument, and the same `ELECTRON_RUN_AS_NODE=1` environment value.
The usual per-user install is under `%LOCALAPPDATA%\\Programs\\later.dog`.

On Ubuntu `.deb` installs, the executable is normally `/opt/later.dog/laterdog` and the script is
`/opt/later.dog/resources/server/mcp-server.js`. Use the same environment value.

## Grok Bot, Claude Code and other apps on a Mac signed in to later.dog Cloud

When the desktop app is signed in to later.dog Cloud, it keeps `cloud-access.json` next to the local tools
token (`~/Library/Application Support/later.dog/` on macOS), readable only by your user account. It holds your
Cloud's address and an "Apps on this Mac" session. The bundled MCP server uses it automatically, so any app on
the Mac that runs the server above (Grok Bot, Claude Code, Cursor and others) reaches your dogs in the Cloud with
the same access the desktop app has. Signing out of later.dog Cloud deletes the file. `LATERDOG_URL` and
`LATERDOG_SERVER_TOKEN` still win when set.

## Connection discovery

With no configuration, the MCP process probes later.dog's three desktop ports (`8799`, `18799`, and `28799`)
and accepts only a health response that identifies itself as later.dog. This handles the desktop's normal
fallback when another local process already owns port 8799.

Set `LATERDOG_SERVER_PORT` to force one local port, or `LATERDOG_URL` to use an explicit HTTP(S) origin. Cleartext remote
HTTP is rejected unless `ALLOW_INSECURE_HTTP=true`; HTTPS should be used outside loopback. An optional
`LATERDOG_SERVER_TOKEN` is sent as a bearer token for authenticated reverse proxies. When a token is set, an
explicit `LATERDOG_URL` or `LATERDOG_SERVER_PORT` is required so the credential is never sent while probing unrelated
local ports. `LATERDOG_MCP_TIMEOUT_MS` can set an HTTP timeout between 1,000 and 120,000 milliseconds.
In packaged builds, `LATERDOG_SERVER_TOKEN` is required for mutating tools as
described above; it is not a generic reverse-proxy secret.

## Tools

| Purpose | Tools |
|---|---|
| Inspect | `get_system_health`, `list_bots`, `list_channels`, `get_bot_messages`, `get_channel_messages`, `search_messages`, `list_available_models` |
| Create and organize | `create_bot`, `update_bot_profile`, `create_channel`, `update_channel`, `create_task`, `switch_task`, `rename_task` |
| Run work | `send_bot_message`, `send_channel_message`, `wait_for_conversation`, `interrupt_conversation`, `set_bot_model` |

`wait_for_conversation` returns `settled`, `needs-user`, `failed`, `stalled`, or `timed-out`, along with a
small redacted transcript tail. MCP cancellation is honored while a tool is waiting.

## Safety and data scope

Transcript reads are paged and capped at 200 messages. Search is capped at 100 hits. Screenshot pixels and
permission grant keys are removed from MCP results. Tool schemas reject unknown fields and malformed values,
and model changes are refused while a bot is working.

The harness itself is local-first and normally binds to loopback. If you expose it through a reverse proxy,
authentication and TLS at that proxy are part of your deployment's security boundary.
