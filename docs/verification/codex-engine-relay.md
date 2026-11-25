# Native Codex engine relay

The relay fixture starts the supplied native app-server in a separate process. It uses disposable work and session directories, a loopback model service, and a fixed child environment. It sends real JSON-RPC requests over the engine relay.

```sh
node scripts/verify-codex-engine-relay.mjs /absolute/path/to/codex /absolute/scratch-directory
```

Run with Node 24 and the Codex version installed in the target home. The scratch directory must already exist. The fixture removes its own files at exit.

The first turn must reach the home with a completed native session file before the completion event arrives. The fixture removes the first computer's files, then starts another relay with a fresh directory. The second app-server must resume the same native thread and include the first turn in its model request. Both turns must complete without reading account files or sending authorization to the model service.

The output records the app-server version, two native turns, and the first checkpoint's SHA-256. The two computer filesystems are simulated on the host. Cloud computer allocation, the deployed process stream, live accounts, and production throughput need their own evidence.
