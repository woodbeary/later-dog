# Native Codex engine relay

The relay fixture starts the supplied native app-server in a separate process. It uses disposable work and session directories, a loopback model service, and a fixed child environment. It sends real JSON-RPC requests over the engine relay.

```sh
node scripts/verify-codex-engine-relay.mjs /absolute/path/to/codex /absolute/scratch-directory
```

Run with Node 24 and the Codex version installed in the target home. The scratch directory must already exist. The fixture removes its own files at exit.

The first turn must reach the home with a completed native session file before the completion event arrives. The fixture removes the first computer's files, then starts another relay with a fresh directory. The second app-server must resume the same native thread and include the first turn in its model request. Both turns must complete without reading account files or sending authorization to the model service.

The output records the app-server version, two native turns, and the first checkpoint's SHA-256. The two computer filesystems are simulated on the host. Cloud computer allocation, the deployed process stream, live accounts, and production throughput need their own evidence.

## Signed-in cloud computer

On November 25 a disposable xlarge cloud computer ran Codex app-server 0.167.2 through the Computers service process stream. The isolated home used the native Codex driver and an access-only account loan. The first turn retrieved a unique value from a home MCP server. A fresh app-server resumed that native thread and returned the value without calling the tool again. A third turn attempted a shell write. The managed hook reached the home and denied it. The file was absent and all three temporary Codex directories had been removed after the turns. The fixture kept its tool secret and account refresh credential off the computer.

A selected dog can move an existing native chat after a home turn saves its session binding. The binding includes the account, provider, dog, chat, cursor and file hash. The home publishes a remote turn as complete after it receives that turn's native completion record. Computer startup can fall back to the home before any prompt has been sent. A lost turn acknowledgement leaves the dispatch pending across automatic recovery.
