# later.dog's own Google connection: one-time setup and release order

later.dog owns one Google client. Its secret lives only in the accounts Worker
(`cloudflare/control-plane`). Google sends every approval to
`https://accounts.later.dog/google-oauth/callback`, which passes it on to the
home named in `state`. Each home still keeps its refresh token in its own vault.
A Cloud home with nothing set up connects Gmail with no work by its owner; a
home whose owner saved a client of their own keeps using that client.

Until the setup below is done, `GOOGLE_CLIENT_ID` is empty, the connection is
off, and a dog that calls `connect_google` on a Cloud home is told "later.dog's
Google connection isn't switched on yet".

## One-time setup for later.dog itself

A person does this once, signed in to the Google account that should own
later.dog's connection. No dog does any of it.

1. In Google Cloud: a project named later.dog, with the Gmail API enabled.
2. Google Auth Platform: app name later.dog, audience External, published
   ("In production"), scopes `openid`, `email` and Gmail read-only
   (`https://www.googleapis.com/auth/gmail.readonly`).
3. A client of type Web application with the redirect address
   `https://accounts.later.dog/google-oauth/callback`, and no other.
4. The client ID goes into `GOOGLE_CLIENT_ID` in
   `cloudflare/control-plane/wrangler.production.json`. The secret goes in with
   `pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.production.json`
   from `cloudflare/control-plane`, typed by a person, never printed, never
   committed.

`CLOUD_HOME_HOST_SUFFIX` is already `-home.later.dog` in every wrangler file.

## Release order

Each piece is safe alone. Release them one at a time, in this order:

1. **The migrations.** `0013_cloud_google_tokens.sql` adds the per-account daily
   counter (500 token calls a day). `0014_cloud_google_refresh_tokens.sql` adds
   the record of which account each refresh token was given to, as a hash.
   Apply both to the production D1 before the Worker that writes to them.
2. **The accounts Worker** (`cloudflare/control-plane`). With `GOOGLE_CLIENT_ID`
   empty or the secret missing, `googleClient()` answers `null` and
   `googleToken()` answers 503; the callback page works either way.
3. **The Worker in front of homes** (`deploy/laterdog/home`). It adds the
   `google.internal` route and gives every home its own key to it, homes made
   before this change included, once. A running home picks up the new
   settings the next time its machine starts. If the accounts Worker is older,
   the route answers 503 and the home says the connection is not switched on.
4. **The home image** (`server/`). Without the two settings from step 3 a Cloud
   home with no client of its own says the connection is not switched on; a
   home that is not a Cloud home still asks for a client of its own, exactly
   as before.

Then do the one-time setup above and deploy the accounts Worker again with the
client ID. Nothing in a home needs to change for it to switch on.

## Before asking Google to verify the app

With one shared client, a person with a home of their own could send someone
else a Google approval link, and if that person approves, the sender's home
gets read access to their Gmail. While the app is unverified, Google shows its
"Google hasn't verified this app" page for later.dog's client too, so this gives
nobody more than a client of their own would. It matters the day Google
verifies later.dog. Before later.dog asks Google for verification, the approval
must return to the device that started it, or the owner must confirm on a page
that names whose later.dog is being connected.
