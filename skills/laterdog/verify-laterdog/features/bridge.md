# Scoped help from a paired computer

**What it is.** A computer pairs once with the supervisor, then takes scoped requests for exact repository roots: read-only metadata inspection, or work handed to its configured local bot. Requests wait while the computer is offline, come back with the same identity after a reconnect, and stop when the device is revoked.

**Where a person finds it.** Cloud jobs → Pair this computer → Create pairing code. Save the code to a private file and run `pnpm laterdog:bridge --pair-code-file <file> --url <supervisor origin>`. Handing work to a local bot also needs `--bot-id` and `--workspace-url`.

**Prove it.** `pnpm exec vitest run server/laterdog/bridge.test.ts server/laterdog/http.test.ts server/laterdog/supervisor.test.ts`. Look for: metadata returned without reading credential files, and symlink escapes refused; a device token confined to its own requests and refused on supervisor routes; a pairing code that works once, a reconnect that redelivers the same request, and revocation.

**Not proven here.** That local work will run. It needs a local bot that is already configured and an explicit local workspace URL, and looking at a remote server does not start a computer-use harness on this machine. Unrelated credentials never belong in a request or an upload.
