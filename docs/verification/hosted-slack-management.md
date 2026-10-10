# Hosted Slack management entry point

Read [the verification entry point](README.md) first. On a hosted organization
workspace, `GET /api/bots/:id/slack-management` answers with the configured
Admin service's `/slack?workspace=<workspace>&bot=<agent>` page, where the
agent gets its own Slack app. Agent settings no longer show a Slack section,
so nothing in the app opens that link now. This app holds no Slack logic: it
never contacts Slack, stores no Slack credential, and reports no connection
status. Names and avatars remain editable in the agent's Details tab.

`GET /api/bots/:id/slack-management` lives in the route module
`server/routes/hosted-slack.ts`, registered in the route table from
`server/index.ts`. It is a client-scoped read (`server/request-auth.ts`), so a
member gets the same link as an admin; every other method on the path stays
admin-only and unrouted. It returns
`{available:true, managementUrl}` only when the agent exists and the runtime
has complete hosted configuration (an https Admin origin and a valid workspace
slug), portal membership, the workspace access hook, and a live `admin`
entitlement. Hidden or missing agents return 404. A local install and a
local-membership workspace return `{available:false}`, not an error. The URL is built from
configuration and the stored agent id, never from request input, and carries
no session, portal grant, or Slack token; Admin authenticates and authorizes
its own visitors.

Run these disposable fixtures:

```sh
pnpm exec vitest run server/hosted-slack.test.ts server/routes/hosted-slack.test.ts server/request-auth.test.ts server/hosted-access.test.ts
pnpm typecheck
pnpm lint
```

The route test serves the module through the route table on a real HTTP
server: the hosted answer, `{available:false}` for a local install, a hook
that is not live and local membership, 404 for missing and hidden agents, and
a pass for every other method and path. The hosted-access test starts an owned
server with a temporary home and fake Admin backchannel. It proves the real
route returns the correct agent link to an admin and to a member, rejects
missing and hidden agents, revokes a demoted admin's session, refuses a
member's write and an unauthenticated read, and withholds the link in local
membership mode. The helper tests cover incomplete or invalid configuration
and URL parameter boundaries.

These checks prove the route and its boundary. They do not
install a Slack app, publish an agent, synchronize a Slack profile, or
exercise Slack messages. The separately deployed Admin service owns those
workflows and needs its own isolated fixtures.
