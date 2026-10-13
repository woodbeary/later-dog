export const CONNECT_MAC = "No Mac is lent to this home yet. To let you use the person's Mac, they install later.dog on it from https://later.dog, sign in with the same email they use here, then turn on Settings → later.dog Cloud → Let My Cloud use this Mac and add folders such as Downloads. Tell them that in one or two sentences.";

export function withConnectMac<T extends { computers: unknown[] }>(listing: T, noMacLent: boolean): T & { connectMac?: string } {
  return noMacLent && listing.computers.length === 0 ? { ...listing, connectMac: CONNECT_MAC } : listing;
}
