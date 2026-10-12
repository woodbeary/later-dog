
export function connectorCardText(label: string, alias?: string): string {
  const app = label.replace(/\s+/g, " ").trim() || "this app";
  const account = alias?.replace(/\s+/g, " ").trim();
  return account ? `Connect ${app} as “${account}” to continue.` : `Connect ${app} to continue.`;
}
