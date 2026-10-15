const UPDATED = "October 13, 2026";

function legalPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · later.dog</title>
<link rel="stylesheet" href="/cloud/style.css">
</head>
<body data-page="legal">
<main class="legal">
<div class="brand">later.dog</div>
<h1>${title}</h1>
<p class="status">Updated ${UPDATED}</p>
${body}
<p>Questions: <a href="mailto:support@later.dog">support@later.dog</a></p>
</main>
</body>
</html>`;
}

export const PRIVACY_PAGE = legalPage("Privacy Policy", `
<p>later.dog is made by The Interpreting App, LLC. This page says what later.dog collects, why, and how to delete it.</p>
<h2>What we keep</h2>
<ul>
<li><strong>Your email address</strong>, to send sign-in codes, to know which home is yours, and for emails your dogs send you when you ask them to.</li>
<li><strong>Your home</strong>: your dogs, chats, pins, photos you send, files your dogs make, their memory and routines. It runs on Cloudflare in a private computer that only your signed-in devices can reach, and it is saved in Cloudflare storage.</li>
<li><strong>Notification tokens</strong> from your iPhone, so your dogs can tell you when they need you. They go through Expo's push service and Apple Push Notification service.</li>
<li><strong>Your Mac, only if you lend it.</strong> When you turn on Let My Cloud use this Mac, your dogs can read the folders you pick (and save in those you allow), and use apps and screen if you allow it. Your Mac keeps its own list of what they did.</li>
</ul>
<h2>Who processes your messages</h2>
<p>To answer you, your messages go to the AI your dog uses. The free models are Claude from Anthropic and Grok from xAI, reached through Cloudflare's AI Gateway, with Kimi on Cloudflare Workers AI as a backup; we turn off prompt logging in the gateway. If you sign in with your own Claude or ChatGPT account, those messages go to Anthropic or OpenAI under your account with them. Spoken replies use Cloudflare Workers AI voices.</p>
<h2>What we don't do</h2>
<p>No ads, no tracking across apps or websites, no selling or sharing your data for marketing. We don't read your chats. We look at your home only if you ask us to help with it.</p>
<h2>Deleting everything</h2>
<p>In the iPhone app, open Settings and choose Delete account, or sign in at <a href="/cloud">accounts.later.dog/cloud</a>. Your account, your home, its dogs, chats and saved files are deleted. This can't be undone.</p>
<h2>Children</h2>
<p>later.dog is not for children under 13.</p>
<h2>Changes</h2>
<p>If this changes in a way that matters, we'll say so in the app before it applies.</p>
`);

export const TERMS_PAGE = legalPage("Terms of Service", `
<p>These terms are between you and The Interpreting App, LLC, which makes later.dog.</p>
<h2>The beta</h2>
<p>later.dog Cloud is free during the beta. It has fair limits, such as a number of free AI messages and emails each day. Things may change or break while we build it, and the beta may end; we'll tell you in the app before it does.</p>
<h2>Your stuff</h2>
<p>What you and your dogs make is yours. You give us permission to store and process it only to run later.dog for you.</p>
<h2>Using it well</h2>
<p>Don't use later.dog to break the law, to harm or harass anyone, to send spam, to attack or break into other systems, or to get around these limits. Your dogs act for you, so what they do with your accounts and your Mac is on you; check what you allow them to do. We may pause an account that puts others at risk.</p>
<h2>The open-source app</h2>
<p>The later.dog app's code is open source under the Apache License 2.0. These terms cover the later.dog Cloud service, not the code.</p>
<h2>No warranty</h2>
<p>later.dog is provided as is. To the extent the law allows, we aren't liable for indirect or consequential losses, and our total liability is limited to what you paid us in the last 12 months.</p>
<h2>Ending</h2>
<p>You can delete your account at any time in Settings. We may end the service with notice in the app.</p>
`);
