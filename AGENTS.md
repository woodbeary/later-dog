# later.dog agent notes

Always use pnpm instead of npm. Node 24+ is required.
Keep native backend limitations visible; fixture success does not qualify a live provider.

Use `cf` for Cloudflare account and zone work (DNS, rules, zone settings, gateways) and
Wrangler for container Workers. Change a container Worker only with a full `wrangler deploy`,
never by patching its settings through the API.

No comments in code. Say it with names, types and tests; only lines tools read
(lint and test directives) and the licence notices adapted code came with stay.
`scripts/no-comments.test.ts` fails on any other; `node scripts/no-comments.ts --write`
removes them.

Describe later.dog on its own terms. Name another product only where later.dog works
with it (an engine it runs, an app that connects to it), never as a model to follow or a
comparison, and never cite studies, captures or reference material. That holds for code,
tests, docs, commit messages and pull requests. `scripts/brand-links.test.ts` keeps known
names out; the attribution the licence requires stays in NOTICE.


Work in progress, its gates, and how to resume any lane: [`docs/laterdog/finish-line.md`](docs/laterdog/finish-line.md). Read it before starting.

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

More specific `AGENTS.md` files override this note within their directories.
