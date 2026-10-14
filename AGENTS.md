# later.dog agent notes

Always use pnpm instead of npm. Node 24+ is required.
Keep native backend limitations visible; fixture success does not qualify a live provider.

No comments in code. Say it with names, types and tests; only lines tools read
(lint and test directives) and the licence notices adapted code came with stay.
`scripts/no-comments.test.ts` fails on any other; `node scripts/no-comments.ts --write`
removes them.


Work in progress, its gates, and how to resume any lane: [`docs/laterdog/finish-line.md`](docs/laterdog/finish-line.md). Read it before starting.

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

More specific `AGENTS.md` files override this note within their directories.
