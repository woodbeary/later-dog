# Always allow

Every permission card offers **Allow once**, **Don't allow** and **Always allow**,
except the kinds listed under "Never Always". Always is kept on the dog and holds
in every chat of that dog, in work it does for a teammate, for its helpers, after
a restart and on any engine or account. When an engine asks for something the dog
is already allowed, the home answers "allow" itself and no card is raised.

**A lasting approval never generalises by default.** `grantKeyFor` in
`server/laterdog/always-allow.ts` turns a request into its key:

| Request | Key | Covers |
|---|---|---|
| Any shell command not on the list below | `exact:<resolved folder> :: <command>` | this exact command text, run from this folder |
| A command on the list, with every argument fitting its rule | `run:git push`, `run:pnpm run build` | what the list says |
| A file edit whose every path (renames included) resolves inside the dog's folders and touches nothing that runs code later | `files:edit` | editing files in its own folders |
| Claude Read, Grep, Glob or LS on a path inside the dog's folders | `files:read` | reading and searching files in its own folders |
| Any of the above on the person's own computer | `computer:` + key | the same, on that computer only |

The dog's folders are its working folder, its chat folders and its home folder,
resolved through links; the home directory and `/` never count.

## The list

It lives in one file, `shared/always-allow.ts`, one reason per entry. Program
names are compared in lower case; subcommands exactly. Options that run another
program, change configuration or write elsewhere (`-c`, `--exec`, `--config`,
`--receive-pack`, `--upload-pack`, `--git-dir`, `--work-tree`, `--global`,
`--prefix`, `--registry`, `--output`, `-o`, `-e`, `-x` and each entry's own
refusals) send the command back to its exact key. Every argument is searched for
paths, also glued to an option (`-o/x`), after `@` and after `name=`; each is
resolved through links and must be inside the dog's folders. `git push`, `pull`
and `fetch` take only a remote already named in the repository's own config and
plain branch names (no URL, refspec, `+` or `:`). Package-manager entries take
no extra arguments; a package script is keyed by its name.

| Command | Covers | Why it is safe to widen |
|---|---|---|
| `git status` | show which files changed in this repository | reads only |
| `git diff` | show changes in this repository | reads only; options that run configured programs or write a file are refused |
| `git log` | show this repository's history | reads only |
| `git show` | show a commit in this repository | reads only |
| `git rev-parse` | look up commit names in this repository | reads only |
| `git ls-files` | list the files this repository tracks | reads only |
| `git add` | stage files inside its own folders | changes only the repository's index; paths are checked |
| `git commit` | record staged changes as a commit in this repository | local only; hooks live under .git, which it can never edit without asking |
| `git switch` | switch branches in this repository | local only |
| `git checkout` | switch branches or restore files inside its own folders | local only; paths are checked |
| `git stash` | set aside and bring back uncommitted changes in this repository | local only |
| `git fetch` | download from a remote this repository already has | no URLs, refspecs or upload programs |
| `git pull` | download and merge from a remote this repository already has | no URLs, refspecs or merge programs |
| `git push` | push branches to a remote this repository already has, without force or deleting anything | no URLs, refspecs, force, deletes or mirror; force-pushing the main branch is also held by the owner guard |
| `pnpm install` | install the packages this folder's lock file already lists | no new package names |
| `pnpm i` | install the packages this folder's lock file already lists | no new package names |
| `npm install` | install the packages this folder's lock file already lists | no new package names |
| `npm ci` | install the packages this folder's lock file already lists | no new package names |
| `yarn install` | install the packages this folder's lock file already lists | no new package names |
| `pnpm test` | run this folder's test script | the script lives in package.json, which it can never edit without asking |
| `npm test` | run this folder's test script | the script lives in package.json, which it can never edit without asking |
| `yarn test` | run this folder's test script | the script lives in package.json, which it can never edit without asking |
| `pnpm run <script>` | run the package script named here, as this folder's package.json defines it | one named script; package.json edits always ask |
| `npm run <script>` | run the package script named here, as this folder's package.json defines it | one named script; package.json edits always ask |
| `yarn run <script>` | run the package script named here, as this folder's package.json defines it | one named script; package.json edits always ask |
| `gh pr view` | read a pull request on GitHub | reads only |
| `gh pr list` | list pull requests on GitHub | reads only |
| `gh pr status` | see the status of your pull requests on GitHub | reads only |
| `gh pr diff` | read a pull request's changes on GitHub | reads only |
| `gh pr checks` | read a pull request's checks on GitHub | reads only |
| `gh issue view` | read an issue on GitHub | reads only |
| `gh issue list` | list issues on GitHub | reads only |
| `gh run view` | read a workflow run on GitHub | reads only |
| `gh run list` | list workflow runs on GitHub | reads only |
| `ls` | list files inside its own folders | reads only; paths are checked |
| `pwd` | print its working folder | reads only |
| `cat` | read files inside its own folders | reads only; paths are checked |
| `head` | read the start of files inside its own folders | reads only; paths are checked |
| `tail` | read the end of files inside its own folders | reads only; paths are checked |
| `wc` | count lines in files inside its own folders | reads only; paths are checked |
| `grep` | search files inside its own folders | reads only; paths are checked |

Left off on purpose, after the review: `git config`, `git branch` (it sets
upstream config), `gh api`, `gh auth`, `gh pr merge` and every other `gh`
command that changes something, `curl`, `wget`, `dd`, `tar`, `zip`, `unzip`,
`scp`, `rsync`, `ssh`, `make`, `npx`, `pnpm dlx`, `npm exec`, `node`, `python`,
`tsx`, `ts-node`, `bun`, `deno`, `java` and every program that runs a file or
inline code, and `rm`, `mv`, `cp`, `ln`, `chmod`.

## Never Always

Every tool that is not known to be read-only (all MCP tools, connected-app
tools, web fetch and search, browser and computer clicks), so sending, posting,
paying and trading always ask whatever the tool is called; older whole-app
connector grants no longer cover anything. Commands carrying anything shaped
like a secret, or naming `mail`, `sendmail`, `osascript` or `stripe`. Deleting
outside the dog's folders. Edits under any `.git`, `.husky`, `node_modules`,
`.claude`, `.codex`, `.cursor`, `.gemini`, `.vscode` or `.idea` folder and to
`package.json`, `.npmrc`, `.yarnrc*`, `.pnpmfile.cjs`, `Makefile`, `.gitconfig`,
`.gitattributes`, `.gitmodules`, `.envrc` and shell start-up files. Sandbox
escapes and anything policy marks for explicit approval. Requests the engine
cannot name (ACP other/read/delete/move, Pi, Codex whole-app access). Every
request in a guest's turn; a guest, and a member who is not an admin, cannot
give a lasting approval.

A dog made by a dog gets only its maker's approvals about talking to other dogs.
Resetting a chat's approval level, or the emergency downgrade, pauses every
grant the dog had in that chat until the person gives that grant again there or
raises the chat's level. The owner guard still runs before every answer from a
grant: force-pushing a default branch, deleting a remote repository or deleting
recursively outside the dog's folders raises a card unless its own key is held.

## The wire

A card carries `allowKey` when Always is offered and `forDog` when the dog works
for another dog. A client answers `POST /api/threads/:id/respond` with
`{ "requestId", "behavior": "allow", "scope": "always" }`; the home stores the
card's key on the asking dog. Older clients that post
`/api/bots/:id/always-allow` first keep working, and `{ "behavior": "allow" }` is
Allow once. `DELETE /api/bots/:id/always-allow?key=` removes a key from the dog
and every chat copy.

## Proof

```sh
pnpm exec vitest run server/laterdog/always-allow.test.ts server/laterdog/always-allow-answer.test.ts \
  server/laterdog/connector-ask.test.ts server/laterdog/dog-creation.test.ts src/lib/allowed.test.ts
pnpm exec vitest run server/laterdog/always-allow.e2e.test.ts
```

The unit tests hold every case from the adversarial review's three probes
(about 250 commands and 45 tool names: wrapped, quoted, case-changed, zero-width
and look-alike programs, glued and `@` paths, links out of the folder, unknown
remotes, refspecs, force, secrets, mail and payment tools, `.git` hooks, renames
out of the folder, read tools without paths), a generated test of 400 variants of
a granted `git push` (options, arguments, folders, quoting, case) that may only
answer inside the listed breadth, and 300 variants of a granted exact command
that may only answer the same text in the same folder. The end-to-end test runs
the real server with the fake engine: a listed command answered by the home in
the same chat, another chat and after a restart; a wider variant and an exact
command in another folder still asking; removal asking again.

Not proven with a real engine: the paths Codex and ACP report for edits and
renames, and whether an engine's own session rules ask less often on top.
Tool annotations (`readOnlyHint`) do not reach the home yet, so no MCP tool gets
Always.
