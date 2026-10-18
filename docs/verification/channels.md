# Channels

## Sub-features

- Create a channel from existing bots.
- Send to its active task.
- Wait for the room-level run rather than one member's transient state.
- Read a bounded channel transcript.

## User path

Create a channel from the sidebar, choose its members, and send a message in
the channel composer.

## Driving it

Create two fixture bots with `new-bot`, then:

```sh
pnpm control:laterdog new-channel --name Review --members BOT_A_ID,BOT_B_ID --url http://127.0.0.1:PORT
# Copy channel.id from the JSON above as CHANNEL_ID.
pnpm control:laterdog send-channel --channel CHANNEL_ID --text "Reply once" --url http://127.0.0.1:PORT
pnpm control:laterdog wait --channel CHANNEL_ID --timeout 60 --url http://127.0.0.1:PORT
pnpm control:laterdog messages --channel CHANNEL_ID --limit 20 --url http://127.0.0.1:PORT
```

Capture the returned channel ID from `new-channel`. The wait result must be
`settled`; the transcript is the evidence.

## Gotchas

- Do not wait directly on a bot while it is speaking for a channel.
- A confirmation card produces `needs-user`; it is not a timeout.
- This first map does not claim to verify channel layout or sidebar UI.

## Group chat routines and plain group turns

```sh
pnpm exec vitest run server/laterdog/room-routine.e2e.test.ts server/laterdog/room-prompt.test.ts
```

A routine that targets a group chat posts its prompt into that chat and its
dog answers as an ordinary reply; the run finishes with that reply as its
output. There are no goal cards and no `/goal` mode: a send that still carries
`mode: "goal"` from an older client is an ordinary chat message. The room
prompt says only who the dog is, who is in the chat and how to @mention.

## Room management by dogs

```sh
pnpm exec vitest run server/chief-rooms.e2e.test.ts
pnpm exec vitest run server/index.test.ts -t 'room management|credential-card ownership'
```

Any dog, the main dog included, can create and manage group chats it is in
with `create_room` and `manage_room`, and finds its group chats from a 1:1
chat with `list_bots`. The end-to-end test launches the isolated control
fixture, creates disposable bots, starts the fake engine and uses that turn's
mounted agents MCP proxy. It creates a room, renames it and changes members,
then checks the saved state. A foreign-section member is refused; stopping the
owning turn revokes the proxy's permission to rename the room. The test retains
its control commands, tool results and final state beside the printed server
log, without recording the bearer token, and removes its temporary home.

The API regressions exercise spoofed sender/thread claims, slow expired
requests, peer allow-lists, hidden bots, busy rooms, pending approvals and
in-flight credential saves. Public channel creation and edits use the same
validation as the room tools. Dogs cannot move rooms or bots between sections,
remove themselves, or change working folders. A dog configured to require peer
approval must ask the person to make room changes; these tools do not add a
separate approval workflow.
