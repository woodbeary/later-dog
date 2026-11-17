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

## Before it is switched on for anyone but Jacob

Putting the client ID in `GOOGLE_CLIENT_ID` switches the connection on for every
Cloud home at once. Two things below hold for every home together. Until both
are settled, the connection is for Jacob alone. One way to keep it so, not
checked here: leave the app's audience in Google's testing state with only
Jacob's Google account as a test user, so Google refuses anyone else's approval.

### 1. Google's cap on people for an unverified app

Google's published rules limit an unverified app that asks for a restricted
scope, and Gmail read-only is one, to 100 users in total. Publishing the app
("In production") does not lift that limit; only Google's verification does.
With one client for every later.dog, every home's people count against the same
100. Once it is reached, nobody on any home can connect. Anyone with a later.dog
account can also use it up on purpose by approving with throwaway Google
accounts. The setup above is not finished while the app is unverified.

### 2. An approval link sent to someone else

As built, this works:

1. Someone with any later.dog Cloud home asks a dog to `connect_google` and
   copies the link on the card. It carries later.dog's client ID, the fixed
   `accounts.later.dog` address, and a `state` that names their own home.
2. They send the link to another person. If that person approves within 15
   minutes, Google sends the code to `accounts.later.dog`, which passes it on to
   the sender's home. That home holds the verifier, so the exchange works, and
   the other person's refresh token lands in the sender's vault.
3. The sender's dogs can then read that mailbox with `gmail_search` and
   `gmail_read`, and `gmail_code_to_vault` can collect the person's emailed
   sign-in codes, which turns read-only Gmail into a way into their other
   accounts.

What limits it today: Google's "hasn't verified this app" page; the state is
single-use and lasts 15 minutes; it lives only in the sending home's memory, so
the link dies if that home restarts; the person can remove later.dog from their
Google account. With a client of their own, a sender gets the same flow under
any app name; what the shared client adds is later.dog's name and the
`accounts.later.dog` address, which make the link look more trustworthy.

The fix, before the connection is open to others and before later.dog asks
Google for verification: the approval must return to the device that started
it, or the owner must confirm on a page that names whose later.dog is being
connected.
