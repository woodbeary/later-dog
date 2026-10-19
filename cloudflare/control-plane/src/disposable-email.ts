const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "10minutemail.com",
  "1secmail.com",
  "burnermail.io",
  "discard.email",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getnada.com",
  "grr.la",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamailblock.com",
  "inboxkitten.com",
  "mail.tm",
  "maildrop.cc",
  "mailinator.com",
  "mailnesia.com",
  "mailpoof.com",
  "mintemail.com",
  "mohmal.com",
  "moakt.com",
  "mytemp.email",
  "sharklasers.com",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempmail.dev",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "tmpmail.org",
  "trashmail.com",
  "yopmail.com",
]);

export function isDisposableEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  if (!domain) return false;
  const labels = domain.split(".");
  for (let start = 0; start < labels.length - 1; start += 1) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(start).join("."))) return true;
  }
  return false;
}
