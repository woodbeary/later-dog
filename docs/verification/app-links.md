# App links

later.dog opens three kinds of link, on the Mac and on a Cloud home window:

| Link | Opens |
|---|---|
| `laterdog://dog/<id>` | That dog's one conversation, or that group chat |
| `laterdog://chat/<id>?thread=<old id>` | The same; the thread id is ignored |
| `laterdog://thread/<old id>?bot=<id>` | The same, for links older dogs wrote |
| `laterdog://settings?section=general\|computer\|usage\|updates` | That Settings page; any other section opens General |

`electron/app-link.mjs` (shared with the renderer and server as
`shared/app-link.ts`) parses and builds them. A dog that is gone, or not shared
with you, shows **Not found** with "This dog was removed or isn't shared with
you." and a Close button, over the conversation that was already open. A link
that does not parse does nothing.

Main keeps one link at a time (the latest wins) in `electron/app-links.mjs`
until the main window's page subscribes through `window.laterdog.onAppLink`,
which sends `app-links:ready` once per page. While a page is navigating away,
links wait. If the navigation is blocked or never commits, the page stays ready
and gets the waiting link when loading stops (`did-stop-loading`). If it commits
(`did-navigate`), fails into an error page (`did-fail-load`) or the page crashes,
the link waits for the next page to say it is ready. One gap remains: a link the
page has received but not yet opened (it waits for the store to load) is lost
if that page navigates away first; the next link works as usual. Every
outcome goes to `server.log` with the scheme and host only:
`app link held|opened|ignored: laterdog://dog [reason]`. Failed external opens
are logged the same way: `external open failed: https://example.com not opened`.

## Check

Never use the installed app. Start a fixture and a renderer for it:

```sh
node --experimental-strip-types scripts/control-laterdog.ts launch
LATERDOG_HOME=<tmp>/home LATERDOG_SERVER_PORT=<fixture port> node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5391 --strictPort
pnpm control:laterdog new-bot --name "Link Target" --url http://127.0.0.1:<fixture port>
```

Then start the source Dev desktop with the link as its argument (cold), and run
the same command again with another link (warm, delivered as a second instance):

```sh
env LATERDOG_VARIANT=dev LATERDOG_HOME=<tmp>/home LATERDOG_USER_DATA=<tmp>/home/desktop \
  LATERDOG_BRIDGE_DIR=<tmp>/home/bridge LATERDOG_BIND=127.0.0.1 \
  ELECTRON_START_URL=http://127.0.0.1:5391 LATERDOG_WORKSPACE_URL=http://127.0.0.1:<fixture port> \
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=9339 \
  'laterdog-dev://chat/<Link Target id>?thread=old'
```

Expected: the cold start opens Link Target; `laterdog-dev://dog/<other id>`
switches to it; `laterdog-dev://chat/missing` shows Not found;
`laterdog-dev://settings?section=usage` opens Usage & Billing;
`laterdog-dev://nope/x?code=SECRET` does nothing. `~/Library/Logs/later.dog Dev/server.log`
has a held, opened or ignored line for each, and no `SECRET`.

The source desktop never registers the scheme with macOS (only packaged builds
do), so `open laterdog-dev://…` from Terminal does not reach it; the argument
form above takes the same `second-instance` path Windows and Linux use. The
macOS `open-url` path is covered by `electron/app-links.node-test.mjs` and has
not been driven on a packaged Dev build.

Tests: `electron/app-link.node-test.mjs`, `electron/app-links.node-test.mjs`,
`electron/preload.node-test.mjs`, `src/lib/app-link-route.test.ts` and
`src/components/AppLinkHost.test.ts`.
