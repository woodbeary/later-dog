export const PROFILE_IPC_CHANNELS = ["profiles:list", "profiles:add", "profiles:switch", "profiles:rename", "profiles:remove"];

const text = (value) => (typeof value === "string" ? value : "");

export function registerProfileIpc({ ipcMain, runner, isPage, senderAllowed, showActive }) {
  ipcMain.on("profiles:page", (event) => {
    let page = false;
    try {
      page = isPage(event) === true;
    } catch {
      page = false;
    }
    event.returnValue = page;
  });
  const handle = (channel, act) =>
    ipcMain.handle(channel, async (event, ...args) => {
      const profiles = runner();
      if (!profiles || !senderAllowed(event)) throw new Error("Profiles are only available in this app's window");
      return act(profiles, ...args);
    });
  handle("profiles:list", (profiles) => profiles.list());
  handle("profiles:add", async (profiles, name) => {
    const { id, ready } = await profiles.add(text(name));
    return { ...profiles.list(), added: { id, ready } };
  });
  handle("profiles:switch", async (profiles, id) => {
    await profiles.switchTo(text(id));
    showActive();
    return profiles.list();
  });
  handle("profiles:rename", (profiles, id, name) => profiles.rename(text(id), text(name)));
  handle("profiles:remove", (profiles, id) => profiles.remove(text(id)));
}
