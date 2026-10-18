export async function pageCapabilities(page, { isLocal, isCloudPage, computerName, build }) {
  return build({
    remote: !isLocal(page),
    computerName: await computerName(page),
    remoteSpeech: isCloudPage(page),
  });
}

export function windowPage(contents) {
  return { sender: contents, senderFrame: contents.mainFrame };
}
