# Adding people to a hosted workspace

## Sub-features

- Who may sign in with an emailed code is the workspace config's `signIn`
  list: `admins` get full access, `members` chat and approvals. Settings has
  no People page, so the app neither shows nor changes the list. On the box,
  `laterdog access list | add EMAIL [--chat-only] | remove EMAIL` edits it;
  an admin can also save it with `PUT /api/config` (`signIn`).
- `<public address>/pair?email=<address>` opens the sign-in page with the
  address filled in; a `@domain` entry uses the plain `/pair` page. Nothing in
  the app builds these invite links now.
- The owner (or a bootstrap script on the box) names the first admin; from
  then on any admin invites, promotes, demotes and removes people. Promotions
  apply at the next sign-in. A list saved through `PUT /api/config` revokes
  removed people's account sessions and lost permissions immediately, and
  ends their open account streams and stream tickets. `laterdog access
  remove` only refuses new sign-ins; existing sessions stay until they expire
  or `laterdog sessions revoke` ends them.
- Independently paired devices are separate from the list and stay paired
  until revoked.

- On a workspace whose members the organization's Admin manages
  (`LATERDOG_ADMIN_MEMBERSHIP=portal`), `GET /api/config` carries
  `membership.peopleUrl` (`<LATERDOG_ADMIN_URL>/people?workspace=<slug>`),
  where Admin manages people; nothing in the app links to it now. A hosted
  workspace refuses pairing codes, so the app offers none there.

## Driving it

```sh
pnpm exec vitest run server/people-invite.test.ts server/email-signin.test.ts server/cli.test.ts src/lib/session.test.ts
```

`server/people-invite.test.ts` boots the real server with no sign-in list and a
stubbed control plane, then walks the requests the removed People card made:
the owner adds the first admin, the admin signs in with the emailed code and
invites a user, the user's link serves the sign-in page, the user gets a
chat-only cookie session and cannot change the list, a promotion applies to
the next sign-in while the device already issued keeps its scopes, a removal
refuses new sign-ins and revokes all old account cookies and tickets, and a
`@domain` entry welcomes everyone there and nobody at a look-alike domain.
`server/cli.test.ts` checks `laterdog access` on a disposable data folder, and
`src/lib/session.test.ts` checks that the sign-in page takes the invited
address from its link.

By hand, on a server with a public address: run `laterdog access add
her@example.com --chat-only` on the box, then open
`<public address>/pair?email=her%40example.com` in another browser. The
sign-in page has the address filled in and the address is gone from the
address bar; the code arrives by email; after it, the app opens as that
person. Remove her with `PUT /api/config` (`signIn` without her address): a
new sign-in for her is refused and her current account sessions end.
Reinviting her requires a fresh sign-in; old cookies do not regain access.

## Not proven here

The real emailed code comes from the control plane, so a live run needs an
address you can read. Removing the last admin is allowed and turns email
sign-in off until someone on the box, or an independently paired
administrator, adds an entry again.
