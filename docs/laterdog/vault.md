# Vault: saved logins and contact details for dogs

Status: proposed, waiting on the owner's yes. Nothing here is built yet.

## What it does

- The person keeps logins (site, username, password, note) and contact details (name, email, phone, addresses) in their Cloud home's vault: Settings → Vault on the desktop and the phone. They add items by hand, or import a CSV exported from their password manager.
- A dog that reaches a sign-in page on its own computer asks to use the saved login for that site. later.dog types the username and password into the page itself. The password never enters the dog's conversation, its tools' output or its logs.
- The person still approves each use, the same way as other asks: Allow, Always allow for that site, or Don't allow.
- If the page's site doesn't match the saved login's site, the ask says so ("This looks like a different site than the one the login is saved for. A lookalike site could take the password.") and Always allow is not offered.
- Contact details can be typed into forms the same way, for checkout and sign-ups. Card numbers wait for payments.

## Where the key lives

- Each home's vault is one file in its data folder, `vault.json`. Every item is encrypted with AES-256-GCM, with the item id as additional data.
- The key is not in the data folder. The home Worker derives it with HKDF-SHA-256 from a Worker secret, using the home's account id as salt and `laterdog-vault-v1` as info. It hands the key to the home's container over an internal host, the way `email.internal` already works. The container keeps it in memory only.
- So the R2 snapshots of a home, and any backup or Cloud move, hold only ciphertext. Reading a vault needs both the snapshot and the Worker secret.
- Deriving from the existing `HOME_SECRET` would avoid a setup step, but rotating `HOME_SECRET` would then make every vault unreadable. A separate secret keeps the two independent, and that is the plan.

## The one setup step (the owner runs it, when the vault ships)

The home Worker runs containers, and changing a container Worker any way other than a full `wrangler deploy` can leave a version without its image, which stops every home from starting. Setting a secret makes a new version too. So the secret goes in during the release that ships the vault, not before:

1. The full `wrangler deploy` of the home Worker with the internal host.
2. The owner runs:

   ```sh
   cd ~/code/dog/deploy/laterdog/home && openssl rand -base64 32 | pnpm exec wrangler secret put VAULT_SECRET
   ```

   The value goes straight from `openssl` to Cloudflare and is never shown.
3. Check that the version now deployed still names the same home image and every earlier secret, and that a home starts. If not, roll back to the version from step 1.

## Filling a page

- Dogs browse with agent-browser sessions on their own computer.
- A new tool, `use_saved_login(site)`, makes the server:
  1. read the session's current URL;
  2. compare the registrable domain with the saved login's (a lookalike check);
  3. ask the person;
  4. run agent-browser's own `fill` for the username and password fields in that session.
- The tool's answer says only what happened ("Signed in fields filled for example.com"). It never includes the values.

## 1Password and other password managers

- They stay the person's own. later.dog never holds a shared account for everyone.
- On their Mac, a dog can use the `op` command through the Mac they lend, with 1Password's own approval on that Mac.
- In the Cloud, the person can paste a 1Password service account token scoped to one vault. It is stored in the vault like any other secret, and the fill tool reads items through it.

## Not in this step

Card numbers and paying (waits for payments), passkeys, and sharing a login between people.
