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
change credentials, or control computer/VM lifecycle. Those actions stay in the human-facing app.

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
read that file by themselves, so Claude Code, Codex and your own scripts on this Mac just work with no setup. They send
the token as `X-LaterDog-Local-Tools` only to a loopback address, never while probing ports for the server, and not at
all when `LATERDOG_SERVER_TOKEN` is set (a paired session token wins). Each launch writes a new token, and the
file is removed at quit; a tool that cached an old one gets "token is out of date; restart the tool". Point
`LATERDOG_LOCAL_CONTROL_TOKEN_FILE` at another file to override the location. Your own scripts can read the same file and
send the same header to `http://127.0.0.1:<port>`.

A request carrying the token may do what a paired device can, except what would let a dog approve itself. These stay with
the desktop app or a paired device, and a local tool is refused with "a dog must not be able to approve its own work":

- answering any card: `POST /api/bots/:id/respond`, `POST /api/threads/:id/respond`, `PATCH /api/bots/:id/cards/:id`, and
  the secret and connector cards (`/api/bots/:id/secret-cards/*`, `/api/bots/:id/connector-cards/*`);
- permission grants: `POST /api/bots/:id/always-allow`, writes to `/api/bots/:id/command-allowlist`, connecting an app
  (`/api/connectors/:slug` writes, `authorize` and `accounts`);
- changing how a dog asks: any `approvalMode` other than `ask` (Heel), `autoApprove: true`, `alwaysAllow` entries,
  `acknowledgeLocalAuto`, `refreshPermissions`, on `POST /api/bots`, `PATCH /api/bots/:id`, `POST /api/bots/:id/tasks`,
  `PATCH /api/bots/:id/tasks/:id`, and in `newBotDefaults` through `PUT /api/config`. Tightening to Heel is allowed. A
  dog created through a local tool always starts on Heel;
- widening a dog on `PATCH /api/bots/:id` or `POST /api/bots`: `toolScope`, `connectorScopes`, `outbound`, `mcpServers`,
  `peers`, `managedSections`, `chiefOfStaff`, `approvePeerComms`, `computer`, `browser`, `composio`, and `cwd` on an
  existing dog;
- minting or running credentials: `POST|DELETE /api/auth/pairing`, `/api/desktop-viewer/*`,
  `/api/desktop/shared-computer-control`, writes to `/api/instances/*` and `/api/mcp/servers*`, `POST /api/cli-test`,
  installing packs (`/api/teams/import`, `/api/org-library/add`, `/api/team-library/github`) and
  `POST /api/workspace-backup/restore`.

The list lives in `server/laterdog/local-tools-scope.ts` and is enforced in `server/request-auth.ts` (routes) and in
`readBody` (fields), with tests in `server/request-auth.test.ts` and `server/laterdog/local-tools-scope.test.ts`.

Any program running as you on this Mac can read that file, a dog's shell included when its mode lets it read your files
and reach the network. That is why the token cannot approve anything, answer a card or grant a permission, and why those
need the desktop app (the owner header never leaves the app) or a paired device.

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
