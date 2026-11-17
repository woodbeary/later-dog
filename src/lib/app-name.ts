const APP_NAMES: Readonly<Record<string, string>> = {
  gmail: "Gmail", googlecalendar: "Google Calendar", googledrive: "Google Drive", googledocs: "Google Docs",
  googlesheets: "Google Sheets", github: "GitHub", linkedin: "LinkedIn", youtube: "YouTube", hubspot: "HubSpot",
  twitter: "X", x: "X",
};

export function appName(slug: string): string {
  return APP_NAMES[slug] ?? slug.split(/[_-]+/).filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}
