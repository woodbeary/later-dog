# Phone push contract

How the later.dog server (a Cloud home, or a Mac running the server) sends push notifications to the iPhone app, and how
the phone answers an approval straight from the notification. The server side lives in
[`server/laterdog/phone-push.ts`](../../server/laterdog/phone-push.ts) and is tested in
[`server/laterdog/phone-push.test.ts`](../../server/laterdog/phone-push.test.ts).

## Registering a phone

| Request | Body | Answer |
| --- | --- | --- |
| `POST /api/phone/push` | `{ "token": "ExponentPushToken[…]" }` | `200 { "ok": true }`, or `400` when the token is not an Expo push token |
| `DELETE /api/phone/push` | the same | `200 { "ok": true }` |

The server keeps the last 20 tokens in `phone-push.json` in its data folder and forgets a token when Expo answers
`DeviceNotRegistered`.

## What each push carries

Every push goes through Expo (`https://exp.host/--/api/v2/push/send`) with `title`, `body`, `sound: "default"` and a
`data` object. Approvals, questions and hand-overs (`takeover`) are sent with `priority: "high"` and
`interruptionLevel: "time-sensitive"`.

| Notification | `categoryId` | `data` |
| --- | --- | --- |
| `approval` that names its card | `approval` | `{ kind: "approval", botId, threadId, requestId }` |
| `approval` that does not name a card | none | `{ kind: "approval", botId, threadId }` |
| `takeover` | none | `{ kind: "takeover", botId, threadId }` |
| any other kind with a dog and a conversation | `reply` | `{ kind, botId, threadId }` |
| anything without a `botId` or `threadId` | none | `{ kind, botId, threadId }` |

`requestId` is never sent for a kind other than `approval`, so a question keeps its `reply` category and the phone's
reply flow is unchanged.

An approval names its card only when the card is in the conversation the notification opens. Today that is every
approval except one raised during a routine run that reports to another conversation: that push opens the conversation
the routine reports to, while the card sits in the run's own, so it is sent without a category and the person answers
it in the app.

The approvals that name their card:

- **Approval needed** cards from a dog's engine (commands, file changes, tools).
- **Send on your behalf?** cards for outbound app actions.
- **Local computer** cards for a dog that wants to use the Mac.
- Cards for a dog that wants to contact, delegate to or post in another dog's conversation or a channel.

## The `approval` category

The phone registers one notification category:

| Category id | Action id | Button | Sends |
| --- | --- | --- | --- |
| `approval` | `allow` | Allow | `behavior: "allow"` |
| `approval` | `deny` | Deny | `behavior: "deny"` |

Allow from a notification is always **allow once**. Cards that also offer *Always allow* on the Mac keep that choice in
the app only.

Recommended on the phone (not verified on a device yet): `opensAppToForeground: false` for both actions,
`isAuthenticationRequired: true` on `allow` so a locked phone has to be unlocked before it approves anything, and
`isDestructive: true` on `deny`.

## Answering

```
POST /api/threads/{data.threadId}/respond
Authorization: Bearer {the phone's session token}
Content-Type: application/json

{ "requestId": "{data.requestId}", "behavior": "allow" | "deny" }
```

Send nothing else: no `always`, `rememberCommand` or `message`.

| Answer | Meaning | What the phone does |
| --- | --- | --- |
| `200 { ok: true, outcome: "allowed-once" }` | allowed | nothing more |
| `200 { ok: true, outcome: "rejected" }` | denied | nothing more |
| `200 { ok: true, outcome: "unavailable" }` | this answer was not applied: the card was already answered, expired, or its dog stopped | say so quietly, or open the conversation |
| `200` with `alreadySettled: true` | someone answered it first; `outcome` is what they chose | nothing more |
| `400` | `behavior` was not `allow` or `deny` | a phone bug |
| `401` | the session expired or was signed out | ask the person to sign in again |
| `403` | this session may not answer the card | open the conversation |
| `404` | nothing in that conversation is waiting on an answer | open the conversation |

The answer is recorded like one given in the app: the card shows it as answered by the phone's session, and the
decision log names that session.

### Why the phone's session is accepted

- `POST /api/threads/:threadId/respond` is open to the `client` scope (`CLIENT_ALLOW` in
  [`server/request-auth.ts`](../../server/request-auth.ts)), and bearer tokens that start `laterdog_sess_` are accepted.
- On a Cloud home only the owner answers cards (`cardAnswerRefusal` in `server/index.ts` asks for the `admin` scope).
  The phone signs in through the Cloud's pairing grant (`createCloudPairing` in
  [`server/cloud-home.ts`](../../server/cloud-home.ts)), which opens sessions with `["admin", "client"]`.
- `server/cloud-personal.e2e.test.ts` already answers a card through this route with a Cloud-paired bearer session.
