# later.dog agent notes

Always use pnpm instead of npm. Node 24+ is required.
Keep native backend limitations visible; fixture success does not qualify a live provider.


Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

More specific `AGENTS.md` files override this note within their directories.
