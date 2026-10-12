export type PrivateScreenFrame = { png: string; mime: string };

export async function captureOutsideHumanControl(
  control: () => { held: boolean; revision: number },
  capture: () => Promise<{ png: string; format: string }>,
): Promise<PrivateScreenFrame | null> {
  const before = control();
  if (before.held) return null;
  const { png, format } = await capture();
  const after = control();
  if (after.held || after.revision !== before.revision) return null;
  return { png, mime: format === "jpeg" ? "image/jpeg" : "image/png" };
}
