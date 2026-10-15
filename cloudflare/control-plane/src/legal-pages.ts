const UPDATED = "October 15, 2026";

export const SUPPORT_EMAIL = "support@later.dog";

export function legalPage(title: string, body: string): string {
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
<p>Questions: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
<p><a href="/support">Support</a> · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a></p>
</main>
</body>
</html>`;
}

export interface DataRecipient {
  name: string;
  role: string;
}

export const DATA_RECIPIENTS: readonly DataRecipient[] = [
  {
    name: "Cloudflare",
    role: "runs later.dog: your account, your home and its computers, storage, and the emails later.dog sends. It also runs the included AI and voices on Workers AI, through our AI Gateway, which is set not to log your messages. That covers Kimi (a model made by Moonshot AI), Cloudflare's Clef models, and Deepgram's Aura voices and Nova dictation. Cloudflare runs these models itself, so Moonshot AI and Deepgram don't receive your data.",
  },
  {
    name: "xAI",
    role: "runs Grok, the other included AI. When Grok answers, because you picked it for a dog or because Kimi is busy, your dog's conversation goes to xAI. If you add your own xAI key for voices or dictation, those go to xAI under your account.",
  },
  {
    name: "Anthropic",
    role: "gets your dog's conversation only if you connect your own Claude account, and then under your account with them.",
  },
  {
    name: "OpenAI",
    role: "gets your dog's conversation only if you connect your own ChatGPT account, and then under your account with them.",
  },
  {
    name: "ElevenLabs",
    role: "gets the words to read aloud, or your dictated audio, only if you add your own ElevenLabs key.",
  },
  {
    name: "Expo",
    role: "passes notifications from your home to Apple, and delivers updates to the iPhone app. It sees each notification's words (like a dog's name and a short line), your notification token, and a random install ID when the app checks for updates.",
  },
  {
    name: "Apple",
    role: "delivers notifications to your iPhone through Apple Push Notification service.",
  },
  {
    name: "Square",
    role: "takes the payment only if you buy a later.dog plan. We never see or keep your card number.",
  },
  {
    name: "GitHub",
    role: "hosts the Mac app's downloads. When the Mac app checks for a new version, GitHub sees your network address.",
  },
  {
    name: "Namecheap",
    role: `forwards email sent to later.dog addresses, like ${SUPPORT_EMAIL}, to our inbox.`,
  },
];

const recipientList = DATA_RECIPIENTS.map((recipient) => `<li><strong>${recipient.name}</strong> ${recipient.role}</li>`).join("\n");

export const DELETE_ON_IPHONE = "On iPhone, tap the button with your initials at the top left of your dogs to open Settings. Tap your email at the top, then Delete Account, and confirm.";
export const DELETE_ON_WEB = `On the web, sign in at <a href="/cloud">accounts.later.dog/cloud</a> with your email, choose Delete account, and confirm.`;
export const DELETE_WITHOUT_SIGN_IN = `If you can't sign in, email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> from your account's email address and we'll delete it for you.`;

export const PRIVACY_PAGE = legalPage("Privacy Policy", `
<p>later.dog is made by The Interpreting App, LLC. This page says what later.dog keeps, who else gets it, how long we keep it, and how to delete it.</p>
<h2>What we keep</h2>
<ul>
<li><strong>Your email address</strong>, to send sign-in codes, to know which home is yours, and for emails your dogs send you when you ask them to.</li>
<li><strong>Your home</strong>: your dogs, their chats, instructions, memory and routines, photos and files you send, files your dogs make, and what's on each dog's computer. It runs on Cloudflare in a private place that only your signed-in devices can reach, and it is saved in Cloudflare storage.</li>
<li><strong>Voice notes.</strong> When you dictate, the audio is turned into text and isn't kept.</li>
<li><strong>Usage</strong>: how much AI and voice your dogs use each day, to keep the fair daily limits. You can see it in Settings → Usage.</li>
<li><strong>Sign-in sessions</strong>: which devices are signed in, with the network address and kind of device they signed in from, for security.</li>
<li><strong>Notification tokens</strong> from your iPhone, so your dogs can tell you when they need you.</li>
<li><strong>Emails you send us</strong>, including Send Feedback and Report in the app. Send Feedback adds the app version and how many dogs you have. Report includes the message you report.</li>
<li><strong>Your Mac, only if you lend it.</strong> When you turn on Let My Cloud use this Mac, your dogs can read the folders you pick (and save in those you allow), and use apps and screen if you allow it. Your Mac keeps its own list of what they did.</li>
</ul>
<h2>Who else gets your data</h2>
<p>To answer you, your messages go to the AI your dog uses. We share with these companies only what each needs for the job listed here, and we choose companies that commit to protect your data at least as well as this policy does.</p>
<ul>
${recipientList}
</ul>
<p>We don't share your data with anyone else, unless the law makes us.</p>
<h2>How long we keep it</h2>
<ul>
<li><strong>Your account and your home</strong>: until you delete your account.</li>
<li><strong>Sign-in codes</strong>: kept scrambled, they stop working after 10 minutes and are then cleared out.</li>
<li><strong>Sign-in sessions</strong>: until you sign out, or after 7 days without use.</li>
<li><strong>Voice notes</strong>: not kept. The audio is turned into text and dropped.</li>
<li><strong>Usage for the fair limits</strong>: only today's count, which starts over each day. Your home keeps its own usage history until you delete your account.</li>
<li><strong>Notification tokens</strong>: until you delete your account, or until Apple says a token no longer works.</li>
<li><strong>Service logs</strong> (which requests reached later.dog, and any errors): 7 days.</li>
<li><strong>Emails you send us</strong>: as long as we need them to help you. Ask and we'll delete them.</li>
<li><strong>Payment records</strong>, if you buy a plan: as long as tax law requires.</li>
</ul>
<p>When you delete your account, we delete it right away. Cloudflare's recovery copies can hold it for up to 30 days more, and then it's gone for good.</p>
<h2>Changing your mind</h2>
<p>When you tap Agree and continue to sign in, you agree to this policy and to your messages going to the AI that answers your dogs. You can take that back at any time:</p>
<ul>
<li>Disconnect your own Claude, ChatGPT, ElevenLabs or xAI account in the Mac app's Settings, and nothing more goes to that company.</li>
<li>Turn off notifications for later.dog in your iPhone's Settings, and nothing more goes to Expo or Apple's notification service.</li>
<li>Turn off Let My Cloud use this Mac, and your dogs stop using your Mac.</li>
<li>Delete your account to stop everything. Your dogs need the included AI to answer, so deleting your account is how you take back that consent.</li>
</ul>
<h2>What we don't do</h2>
<p>No ads, no tracking across apps or websites, no selling or sharing your data for marketing. We don't read your chats. We look at your home only if you ask us to help with it.</p>
<h2>Deleting everything</h2>
<p>${DELETE_ON_IPHONE}</p>
<p>${DELETE_ON_WEB}</p>
<p>Your account, your home, its dogs, their chats, computers and saved files are deleted. This can't be undone. Anything saved on your own Mac stays there until you remove it.</p>
<p>${DELETE_WITHOUT_SIGN_IN}</p>
<h2>Children</h2>
<p>later.dog is not for children under 13.</p>
<h2>Changes</h2>
<p>If this changes in a way that matters, we'll say so in the app before it applies.</p>
`);

export const TERMS_PAGE = legalPage("Terms of Service", `
<p>These terms are between you and The Interpreting App, LLC, which makes later.dog.</p>
<h2>The service</h2>
<p>later.dog Cloud has fair limits, such as a number of free AI messages and emails each day. We keep improving it, so things change. If a change matters, we'll tell you in the app before it applies.</p>
<h2>Your stuff</h2>
<p>What you and your dogs make is yours. You give us permission to store and process it only to run later.dog for you.</p>
<h2>Using it well</h2>
<p>Don't use later.dog to break the law, to harm or harass anyone, to send spam, to attack or break into other systems, or to get around these limits. Your dogs act for you, so what they do with your accounts and your Mac is on you; check what you allow them to do. We may pause an account that puts others at risk.</p>
<h2>The open-source app</h2>
<p>The later.dog app's code is open source under the Apache License 2.0. These terms cover the later.dog Cloud service, not the code.</p>
<h2>No warranty</h2>
<p>later.dog is provided as is. To the extent the law allows, we aren't liable for indirect or consequential losses, and our total liability is limited to what you paid us in the last 12 months.</p>
<h2>Ending</h2>
<p>You can delete your account at any time: in the iPhone app under Settings → your email → Delete Account, or at <a href="/cloud">accounts.later.dog/cloud</a>. We may end the service with notice in the app.</p>
`);
