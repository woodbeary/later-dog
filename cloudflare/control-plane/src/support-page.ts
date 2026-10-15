import { DELETE_ON_IPHONE, DELETE_ON_WEB, DELETE_WITHOUT_SIGN_IN, SUPPORT_EMAIL, legalPage } from "./legal-pages";

export const SUPPORT_PAGE = legalPage("Support", `
<p>later.dog gives you AI helpers. We call them dogs. Make a dog for each job and it gets to work. Each dog has its own chat and its own computer in your home, a private place in the cloud, so it keeps going after you close the app. Use it on iPhone, or with the free Mac app.</p>
<h2>Get help</h2>
<p>Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. Say what you were doing and what happened. A screenshot helps.</p>
<p>In the iPhone app, Settings → Send Feedback writes the email for you. To report something a dog said, press and hold the message and tap Report.</p>
<h2>Common questions</h2>
<ul>
<li><strong>My dogs take a moment to show up.</strong> After a quiet spell your home can take up to a minute to wake. The list fills in by itself.</li>
<li><strong>My sign-in code didn't come.</strong> Check your spam folder, wait a minute, then ask for a new code. Each code works for 10 minutes.</li>
<li><strong>Do my dogs stop when I close the app?</strong> No. They keep working in your home and let you know when they need you.</li>
</ul>
<h2>Delete your account</h2>
<p>${DELETE_ON_IPHONE}</p>
<p>${DELETE_ON_WEB}</p>
<p>This deletes your account, your home, its dogs, their chats, computers and saved files. It can't be undone.</p>
<p>${DELETE_WITHOUT_SIGN_IN}</p>
<h2>Privacy and terms</h2>
<p>Read what we keep and who else gets it in the <a href="/privacy">Privacy Policy</a>, and the rules in the <a href="/terms">Terms of Service</a>.</p>
`);
