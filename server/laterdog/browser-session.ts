const DESKTOP_PROFILE = /^p[a-f0-9]{12}$/;

export function desktopProfileSession(partitionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const profile = env.LATERDOG_DESKTOP_PROFILE;
  return profile && DESKTOP_PROFILE.test(profile) ? `${profile}.${partitionId}` : partitionId;
}
