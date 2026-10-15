# Cloud home images: build on GitHub, deploy by tag

Each account's Cloud home runs the image built from `Dockerfile` (target `cloud-home`) plus
`deploy/laterdog/home/Dockerfile`. The GitHub Actions workflow **Cloud home image**
(`.github/workflows/cloud-home-image.yml`) builds that image on GitHub's runner, boots it, runs
`deploy/laterdog/home/smoke.mjs`, pushes it to `ghcr.io`, and, once the one-time setup below exists, pushes the
same image to Cloudflare's registry as `later-dog-home:<first 12 characters of the commit>`.

The image never passes through the Mac. Deploying stays a person's step: point the home Worker's config at the
tag and run `wrangler deploy` on the Mac. That uploads the Worker code and the image address only; it does not
build, pull or push an image, so Docker does not need to run.

## One-time setup

### 1. A Cloudflare API token that can push images

In the Cloudflare dashboard, on the later.dog account:

1. Open **Manage Account** > **Account API Tokens** (<https://dash.cloudflare.com/?to=/:account/api-tokens>).
2. Click **Create Token**.
3. Next to **Create Custom Token**, click **Get started**.
4. Name it `later.dog GitHub image push`.
5. Under **Permissions**, choose **Account**, **Containers**, **Edit**.
6. If the page asks for account resources, include only the later.dog account.
7. Click **Continue to summary**, then **Create Token**.
8. Copy the token. Cloudflare shows it once.

Why **Containers: Edit**: `wrangler containers push` asks the Containers API for short-lived registry credentials
(`POST /accounts/<account id>/containers/registries/registry.cloudflare.com/credentials`, which wrangler requests
under its `containers:write` scope), then runs `docker login` and `docker push` against `registry.cloudflare.com`.
Cloudflare's [permission list](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) describes
Containers Edit as "write access to Containers" and also lists it as Containers Write. The token
cannot deploy Worker code, but Containers Edit does reach the account's container applications through the API, so
keep it only as a GitHub secret.

### 2. Hand it to GitHub

From the repository root on the Mac:

```sh
gh secret set CLOUDFLARE_API_TOKEN -R woodbeary/later-dog
gh variable set CLOUDFLARE_ACCOUNT_ID -R woodbeary/later-dog --body "$(node -p 'require("./deploy/laterdog/home/wrangler.production.json").containers[0].image.split("/")[1]')"
```

The first command asks for the token; paste it there. The second reads the account ID from the committed
production config, so nothing is typed by hand.

The workflow reads `CLOUDFLARE_ACCOUNT_ID` from a repository variable first and a secret second, so this also works:

```sh
gh secret set CLOUDFLARE_ACCOUNT_ID -R woodbeary/later-dog --body "$(node -p 'require("./deploy/laterdog/home/wrangler.production.json").containers[0].image.split("/")[1]')"
```

The variable is the better home for it. The account ID is not secret (it is already in
`deploy/laterdog/home/wrangler.production.json`), and GitHub hides every secret value wherever it appears: with the
ID as a secret, the run summary shows `registry.cloudflare.com/***/later-dog-home:<tag>` and GitHub drops the job's
`cloudflare-image` output, because it skips job outputs that contain a secret. The push itself and the
`cloudflare-tag` output work either way.

### 3. Check it

```sh
gh workflow run cloud-home-image.yml -R woodbeary/later-dog --ref <branch>
```

Open the run on GitHub. Its summary has a **Cloudflare registry** section with the image address and its tag. If
the section says **Skipped**, the secret or the account ID is missing. To list what the registry holds:

```sh
pnpm dlx wrangler@4.149.0 containers images list
```

## What a run produces

| Where | What |
| --- | --- |
| `ghcr.io/woodbeary/later-dog-home:<full commit>` | The image, for anyone who needs to pull it |
| `registry.cloudflare.com/<account id>/later-dog-home:<12 characters>` | The same image in Cloudflare's registry, which the home Worker deploys |
| Run summary, **Cloudflare registry** | The address and the tag, or why the push was skipped |
| Job output `cloudflare-image` | The full registry address (dropped by GitHub when the account ID is a secret) |
| Job output `cloudflare-tag` | `later-dog-home:<12 characters>` |

The workflow runs when started by hand (`gh workflow run`, or **Run workflow** on the Actions page, from any branch)
and on pushes to `laterdog/home` that touch the image's files. A run takes a few minutes. The tag is always the first
12 characters of the commit the run built, so `git rev-parse <commit> | cut -c1-12` gives it too.

The push uses `wrangler@4.149.0` through `npx`, the same version `deploy/laterdog/home/pnpm-lock.yaml` installs.

## Deploy a pushed image

On the Mac, in a clean checkout of the commit the image was built from, so the Worker code and the image match:

```sh
cd deploy/laterdog/home
pnpm install --frozen-lockfile --ignore-workspace
short=<the 12 characters from the run summary>
node -e '
const fs = require("fs");
for (const file of ["wrangler.production.json", "wrangler.bootstrap.json"]) {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const container of config.containers) container.image = container.image.replace(/:[^:/]+$/, ":" + process.argv[1]);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  console.log(file, config.containers.map((container) => container.image).join(" "));
}' "$short"
pnpm exec vitest run test/config.test.ts
pnpm exec wrangler deploy --config wrangler.production.json --dry-run
pnpm exec wrangler deploy --config wrangler.production.json --containers-rollout=immediate
```

The `node` step points both container classes (`CloudHomeHost` and `CloudHomeHostLarge`) in both configs at the new
tag and keeps the account ID already there. `test/config.test.ts` checks that both classes still share one image. The
bootstrap config only exists to deploy the home Worker before the accounts service; keeping its image in step means a
bootstrap deploy never rolls a home back.

Then commit the two config files on the branch, so the repository names the image that is live.

### What `--containers-rollout=immediate` does

From Cloudflare's [Rollouts](https://developers.cloudflare.com/containers/configuration/rollouts/) page:

- The new Worker version goes live first, then the rollout targets every running home in one step instead of the
  default `[10, 100]` steps (the home config has `max_instances` of 400 and 10).
- Each running home gets `SIGTERM`, has up to 15 minutes to exit, and starts again on the new image. Homes that are
  asleep start on the new image the next time they wake.
- A successful deploy means the rollout started, not that it finished.

`deploy/laterdog/home/runtime/run.mjs` passes `SIGTERM` to the later.dog server, waits for it to exit, and saves a
last snapshot of `/data/.laterdog` to R2 before the container stops; the new container restores it on start.

Cloudflare can keep starting the old image for a few minutes after a deploy. `pnpm exec wrangler containers list`
gives the application ID, and `pnpm exec wrangler containers instances <app id>` shows which version each home runs.
Wait for the new one before judging a fix.

To roll back, deploy the previous tag the same way: `git log -p -- deploy/laterdog/home/wrangler.production.json`
lists the earlier ones, and the registry keeps them.

## What has been proven and what has not

- Proven: the workflow file parses; the push step's script ran on the Mac against stand-in `docker` and `wrangler`
  commands for a clean push, a push with Windows line endings, a push that reports another image, a push that
  reports no address, and a failed push (only the first two pass); the source of `wrangler@4.149.0` prints
  `Pushed image: <address>` after a push, which is the line the step reads.
- Not yet proven: a real push from GitHub (the secret and the account ID are not set yet), that Containers Edit alone
  is enough for that push, and a deploy from a pushed tag with `--containers-rollout=immediate`. The first run after
  the setup above proves the first two; record it here. The token clicks follow Cloudflare's docs and have not been
  walked through.
