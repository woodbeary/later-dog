export const CONNECT_MAC = "No Mac is connected yet. To use their Mac, the person installs later.dog on it from https://later.dog and signs in with the same email they use here; it connects by itself. If later.dog is already on that Mac, they open it and check that Settings → later.dog Cloud → Let My Cloud use this Mac is on. Tell them that in one or two sentences.";

export function macOffline(known: { name: string }[]): string {
  const names = [...new Set(known.map((computer) => computer.name))];
  const subject = names.length === 1 ? `Their Mac "${names[0]}" is` : `Their Macs (${names.map((name) => `"${name}"`).join(", ")}) are`;
  return `${subject} offline right now: later.dog has to be open on it, the Mac awake, and Settings → later.dog Cloud → Let My Cloud use this Mac on. Tell them in one line, and don't substitute files from this server.`;
}

export function withConnectMac<T extends { computers: unknown[] }>(listing: T, noMacLent: boolean): T & { connectMac?: string } {
  return noMacLent && listing.computers.length === 0 ? { ...listing, connectMac: CONNECT_MAC } : listing;
}
