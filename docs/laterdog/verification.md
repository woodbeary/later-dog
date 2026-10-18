# later.dog verification map

Run all checks with Node 24+ and pnpm. The fixtures use temporary data and synthetic external-provider boundaries. They never send cloud tasks to a real account or publish fixture PRs to GitHub.

| Feature | Driver and observable proof |
| --- | --- |
| Workspace delegation | `server/laterdog/http.test.ts`: MCP → authenticated HTTP → SQLite, same request identity creates one job |
| Dog access | `dog-access.test.ts`: a dog's derived token delegates, inspects and acts on its own job through MCP → HTTP → SQLite; repositories, logins, verification checks, GitHub, device pairing, another dog's job, a forged bot header and the admin token sent as a dog are refused, each in one sentence; the admin token keeps every route; the Worker's token derivation matches the supervisor's. `dog-access.e2e.test.ts`: a real disposable later.dog server mounts a conversation's `laterdog` server (behind its gate) with that dog's token, the admin token appears nowhere in the engine's argv, environment or MCP config, and that exact launch is scoped. The Worker's acceptance is typechecked, not run |
| Queue and recovery | `supervisor.test.ts`: independent jobs in two repos, conflicting scopes, four-slot policy, restart, unknown submission, correction and review |
| Remote publication | `github.test.ts`: real isolated Git checkout and bare remote; one PR after lost response, staged-patch recovery, out-of-scope rejection |
| Verification | Exact head receipt; moved PR or truncated check evidence is blocked; manifests from a separate session cannot attach to another head |
| Conversation wakeup | `workspace.e2e.test.ts`: real disposable later.dog server, authenticated proxy and pinned-thread callback, duplicate-safe send identity; and with a supervisor that never calls the desktop (hosted), the server pulls the wake-up itself, delivers it once and settles it. `wakeups.test.ts`: only the pulling desktop's dogs, oldest first; delivered, dropped with its reason on the job, or kept for a spend cap; dog tokens refused; the Worker answers a pull itself only when the supervisor reported nothing waiting for those dogs. The Worker's routing is typechecked, not run |
| Local bridge | Pair once, hash credentials, scoped requests, offline/redelivery and revocation; metadata inspection's filesystem confinement |
| Desktop → supervisor connection | `config.test.ts`: environment wins over `supervisor.json`, which wins over the local default; a hosted connection with a missing token file throws instead of minting a token; plain-HTTP non-loopback origins are rejected |
| GitHub access as publishing sees it | `github.test.ts`: `gh api user` through the publisher's own runner; signed-out state carries gh's message, never a credential; `GH_TOKEN` is reported as the source when set |
| [Token battery](token-battery.md) | `server/account-battery.e2e.test.ts`: real disposable server, two fake Claude accounts; a usage limit on account 1 becomes one switch notice (in place of the limit row) and the request re-runs on account 2 with the conversation replayed (a continuation when a tool already ran), then "Back on" once after the reset; with both accounts out, it waits and picks up where it stopped (in place of the limit row) once a limit resets; booking per account. Live accounts not yet accepted |
| The dog | `src/components/Avatar.test.ts`: every breed (data in `src/components/dog-breeds.ts`) draws two ears (hanging ones in front of the face), eyes with a glint, a nose, a mouth and its markings on the head, only in tones of the dog's colour; it carries its mood and a paused dog stays still; `scripts/laterdog-mark.ts` draws the app icon from the same Retriever. How the breeds look is judged by eye, and reduced motion is CSS only and untested |
| Treats | `src/lib/treats.test.ts`: counts per dog, tells listeners, survives blocked or garbage storage |
| Dogs make dogs | `server/laterdog/dog-creation.e2e.test.ts`: real disposable server and fake engine; an ordinary (non-Chief) dog's mounted agents proxy lists `create_bot` and none of the Chief-only tools, its prompt says it may create one itself, and the call creates Scout in its section with connected apps, automatic approvals and peer-approval skipping off and its own audience; Scout's chat opens with "Hi Jacob, I'm Scout. Biscuit set me up for research and writing. What should I start on?". A duplicate name, a fifth creation in one turn and an archived dog are refused. `dog-creation.test.ts`: the greeting without a person, creator or role, the asker's name on a shared workspace, the tool result. Whether a live model asks its one question before creating is not tested |
| Launch without prompts | `electron/cua-launch.test.mjs`: on macOS the driver start reads the grants through `permissionChecklist` (`isTrustedAccessibilityClient(false)`, never a prompt) and records "Accessibility and Screen Recording required; later.dog asks for them when a dog first uses this Mac"; `electron/cua-grant.node-test.mjs`: the driver starts by itself once both grants read as granted, and never while it runs, after a stop or on another platform; `src/components/ComputerPanel.simple.test.ts`: a chosen This Mac with a grant missing draws the two Allow rows in place of its screen and nothing points at Settings; `src/components/CredentialStoreNotice.test.ts`: a locked keychain shows one card with the relaunch. Not verified live: a packaged launch on a fresh macOS account, which still raises the keychain prompt until the build is signed with a Developer ID. |
| Cloud home first trip and phone round trip | `scripts/cloud-home-trip-check.mjs`, run by the "Cloud home image" workflow right after `deploy/laterdog/home/smoke.mjs` against the freshly built image (behind its Caddy, restarted by its own launcher): a disposable desktop server with three dogs that have each answered once is copied in by the desktop's own engine (`electron/cloud-auto-move.mjs` around `createCloudMove`, profile `cloud-move`, `verifyArrival`, `yieldToOtherComputer`) using owner codes signed with the bootstrap secret the way the Worker signs them; the home then lists the same dogs with every chat line in order; a second sign-in copies nothing and the home's server keeps its process; a paired phone session sends to a dog with `POST /api/bots/:id/messages`, sees the message on its live stream and reads it back. Three minutes at most, about 25 s on a Mac. `scripts/cloud-home-trip-check.e2e.test.ts` runs the same check in the vitest suite against a home server started without Docker, its engine signed out like the image's; `scripts/cloud-home-trip-check.test.ts` covers the edge client, the signed pairing (accepted by the server's own check) and the comparison. Not covered: Cloudflare itself (the Worker, the Durable Object's wake and pairing, R2 save and restore), a real engine reply on the home, and the iPhone app's own screens |

```sh
pnpm typecheck
pnpm lint
pnpm laterdog:test
pnpm build
pnpm laterdog:skills
```

CI also runs later.dog's whole vitest suite in four shards (`pnpm exec vitest run --shard=N/4`), plus
`pnpm broker:test` and `pnpm test:electron`; a change that breaks any of those tests turns CI red. The control plane's
own tests (`pnpm control-plane:test`) are not run in CI.

The conversation fixture follows the shared [verification control surface](../verification/README.md). Evidence persists in `.laterdog-evidence/conversation/receipts.json` and `server.log` after disposable data cleanup. The isolated browser preview runs with `node scripts/laterdog-preview.mjs`, prints its URL, and stops only its owned processes on Ctrl-C; its server log also survives cleanup.

## Launch check, 2026-10-11

Run against the real services the night before launch.

- **The download.** The release linked from later.dog (v0.3.7, 279 MB) matches its published SHA-256, carries a valid signature and needs macOS 12. Gatekeeper refuses it as not notarized, so the first open needs Open Anyway, as the site says.
- **A clean install.** That zip, unpacked and opened with its own home folder, a mock keychain and a stand-in Claude CLI: the welcome flow ran (name, model providers, first dog) with no macOS permission prompt at launch; the first dog started Off-leash, greeted by name and answered; Settings, Computer offered the free trial from cloud.later.dog; Check for updates found 0.3.7 is the newest.
- **The free trial on cloud.later.dog.** Offer, link, an owner grant in place of the human check, active in the app and the service, a cloud computer started, the dog's screenshot tool on it, minutes counted, its live screen in the Computer panel, ended, the key refused afterwards, the computer deleted.
- **The human check, passed by a person.** On the afternoon of 2026-10-11 a person opened later.dog 0.3.8 in a fresh profile (its own home folder and a stand-in Claude CLI), pressed **Try a cloud computer free** in a This Mac dog's Computer panel, ticked Cloudflare's check in their own browser and started the trial. cloud.later.dog accepted the token for its hostname, the `trial` action and that claim; the trial read active with 27 of 30 minutes left, and its cloud computer was running in the dog's Computer panel. A forged token is still refused.
- **Cloud tasks.** A real task (a security review of the cloud service) ran on the hosted supervisor in about four minutes and returned its diff.
- **Token battery.** See the [live record of 2026-10-10](token-battery.md#verification-and-limits).
- **An update.** The released 0.3.7, opened with its own home folder, found v0.3.8 on GitHub, downloaded it and, on quit, installed it in about eight seconds; the bundle then read 0.3.8 with a valid signature and the same designated requirement, and reopened on the same profile with its dog and messages.

Still unproven: a notarized build, and ChatGPT (Codex) accounts at a real limit.

## Live Codex Cloud acceptance

First run on 2026-10-08: all seven steps exercised against two real repositories through the hosted supervisor, with
four defects found and fixed along the way. Still open: raising concurrency only after more runs. The steps, for the next run:

1. Publish a supported cloud environment for a real repository. Record its generation and CLI version, selected profile, setup instructions and network access.
2. Submit one narrow job from later.dog, retrieve its diff and retain task identity.
3. Use an actually remote publishing supervisor to create the draft PR. Observe the branch and PR on GitHub, rather than inferring them from a returned command.
4. Run real behavioral verification and independent review for the current PR head.
5. Send a correction in the source conversation. Observe a new repair task starting from the published result branch and updating the existing PR without a manual relay.
6. Run two independent jobs in one repository and one in another; restart the supervisor, disconnect the desktop, introduce a failing check and correct it. Confirm no duplicate submissions or PRs.
7. Record allowance, intervention, regression, repair, completion and cost observations with evidence. Increase concurrency only after observed capacity supports it.

Current implementation cannot provision an environment through the CLI, continue a native cloud task, cancel an already submitted native task, or establish Cloudflare grant coverage. Chrome sign-in and a reusable environment are prerequisites for the live acceptance. Fixture success does not close these items.

The public repository also runs a macOS preview build on the standard `macos-14` GitHub-hosted runner, checking the application identity and bundled supervisor. It is signed with later.dog's own certificate, or with a Developer ID and notarized on release once those secrets exist ([releasing](releasing.md#signing-and-notarization)). An explicit workflow-dispatch tag publishes the zipped arm64 application and checksum; existing release assets are never overwritten. This validates packaging, not desktop installation or live provider access. Standard hosted runners are free for public repositories: https://docs.github.com/en/actions/reference/runners/github-hosted-runners.

The separate Ubuntu container job builds the real supervisor image, starts it without provider credentials, checks HTTP authentication, saves repository state, and recreates the container against the same volume. It requires unchanged credentials and persisted SQLite state with zero submitted jobs. To repeat locally with an available Docker daemon: `docker build -f deploy/laterdog/Dockerfile -t laterdog-supervisor:smoke .` then `node scripts/smoke-laterdog-container.mjs`. This container smoke does not establish a deployed remote account or Codex environment.
