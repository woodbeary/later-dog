export function pasteMenuItem(params, clipboard, webContents) {
  let attachment = false;
  if (params.isEditable && !params.editFlags.canPaste) {
    try {
      attachment = clipboard.availableFormats().some((format) =>
        ["public.file-url", "NSFilenamesPboardType", "text/uri-list"].includes(format)
      ) || !clipboard.readImage().isEmpty();
    } catch {}
  }
  return {
    label: "Paste",
    enabled: params.isEditable && (params.editFlags.canPaste || attachment),
    ...(attachment ? { click: () => webContents.paste() } : { role: "paste" }),
  };
}
