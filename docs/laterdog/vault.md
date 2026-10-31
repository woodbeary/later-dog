# Vault: saved logins and details for dogs

Dogs sign in to sites on their cloud computers with Secure Forms: the dog opens the
sign-in page, asks with a sealed card, and later.dog types what the person enters
straight into the page. The vault keeps those logins so the person doesn't type
them again, and dogs still never see a password. It also keeps the person's own
details (name, email, phone, address) for checkout, booking and sign-up pages.

## What the person sees

- **Settings → Vault** lists saved logins (site, username, a note, when one was last
  used). The person adds, edits and removes them, or imports a CSV exported from
  1Password, Bitwarden, Chrome, Safari, Firefox or LastPass. Passwords are never
  shown again after saving.
- A Secure Form for a site with a saved login offers it at the top: **Use** fills the
  form from the vault. A box under it, **Let {dog} use it on {site} without
  asking**, adds `vault:{site}` to that dog's **Allowed without asking** list, where
  it can be removed.
- When the person types a login into a form with a username and a password, **Save
  this login to your vault** keeps it for next time.
- A form for a site that only looks like one with a saved login (paypa1.com for
  paypal.com, paypal-secure.com, a different ending, one letter off, lookalike
  characters) warns: "This is paypa1.com, not paypal.com, where your login is saved.
  A lookalike site could take your password, so type it only if you're sure." It
  offers no saved login and no Save box there.
- **Settings → Vault → Your details** keeps a full name, email, phone, company and a
  postal address. A Secure Form whose boxes are tagged as contact details shows **Use
  my details**, which fills the boxes it has a detail for (a first or last name is
  split from the full name, a one-line street address joins the two address lines);
  the person checks them, types the rest and presses Continue as usual. **Save these
  to my details** keeps what they typed in tagged boxes for next time. Boxes the page
  doesn't require are marked optional and may stay empty.

## What the dog sees

It asks for a sign-in with `request_secure_form` as before. For contact details on a
checkout, booking or sign-up page it asks the same way, one field per box on the
page, each tagged with its HTML autocomplete name (`name`, `given-name`,
`family-name`, `email`, `tel`, `organization`, `street-address`, `address-line1`,
`address-line2`, `address-level2` for the city, `address-level1` for the state or
region, `postal-code`, `country-name`) and `optional: true` on boxes the page doesn't
require. A form asks for 1 to 10 fields. When the person leaves an optional box
empty, the wake-up names it and `fill_secure_field` on it says there is nothing to
type. A form tagged with contact details never takes a saved login.
When the dog may use the site's only saved login without asking, the form comes back
already filled and the tool's answer tells it to type each value with
`fill_secure_field` straight away; the card appears quietly, with no notification.
Otherwise the person picks on the card, and later.dog wakes the dog as usual. A login
only fills a form for its own site (accounts.google.com takes the login saved for
google.com), and only forms of a username and a password, or either alone for a
two-step sign-in. Forms with a one-time code stay with the person.

## Where it is kept

- Each Cloud home keeps one file, `vault.json`, in its data folder. Every login is two
  AES-256-GCM sealed parts, one for the site, username and note and one for the
  password, each bound to the login's id and part. Lists open only the first part;
  the password is opened only to fill a form.
- The key is never written anywhere. The home's server derives it with HKDF-SHA-256
  from the home's own bootstrap secret (which the home Worker derives from
  `HOME_SECRET` and hands only to the server process, never the dogs), with the
  home's machine id in the salt and `laterdog-vault-v1` as the info. So R2 snapshots,
  restore points and Cloud moves hold only ciphertext, and opening a vault needs the
  Worker's secret as well as the snapshot.
- `HOME_SECRET` also names every home (its machine id and address), so it cannot
  change without moving every home anyway; a separate vault secret would add a setup
  step and a Worker change without making the vault more independent.
- The person's details are one more sealed part, bound to `details`, in the same file.
- A vault that does not open with the key is shown as locked and is never written
  over. A later.dog without a Cloud home has no key, so Settings says saved logins
  are kept in later.dog Cloud.

## Limits

- Up to 500 logins; values up to 512 characters on one line, as a page can take them.
- One set of details; each up to 200 characters on one line.
- Imports read up to 5,000 rows of a file up to 2 MB, skip rows without a website or
  password, replace a saved password when the export's differs, and count what they
  skipped.

## Not in this step

Card numbers and paying (waits for payments), one-time codes from the vault, passkeys,
sharing a login between people, more than one address, and letting a dog use the
person's details without asking. 1Password stays each
person's own and later.dog holds no shared account; using it through 1Password's own
`op` command on a lent Mac is not built or checked yet.
