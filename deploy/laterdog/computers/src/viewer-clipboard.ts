export const PASTE_TYPED_MOST = 2000;
export const PASTE_SETTLE_MS = 300;
export const NOTE_SHOWN_MS = 1600;

export const CLIPBOARD_WORDS = {
  pasted: "Pasted",
  copied: "Copied",
  nothingToPaste: "Nothing to paste",
  nothingToCopy: "Select text on the computer first",
  notConnected: "Not connected yet",
  pasteRefused: "Allow clipboard access to paste",
  copyRefused: "Allow clipboard access to copy",
} as const;

export const VIEWER_CLIPBOARD_SOURCE = String.raw`
const PASTE_TYPED_MOST = ${PASTE_TYPED_MOST};
const PASTE_SETTLE_MS = ${PASTE_SETTLE_MS};
const CLIPBOARD_WORDS = ${JSON.stringify(CLIPBOARD_WORDS)};
const KEYSYM = { backspace: 0xff08, tab: 0xff09, enter: 0xff0d, escape: 0xff1b, delete: 0xffff, shift: 0xffe1, control: 0xffe3, altLeft: 0xffe9, superLeft: 0xffeb, superRight: 0xffec, v: 0x76 };
const COMMAND_HELD = [KEYSYM.altLeft, KEYSYM.superLeft, KEYSYM.superRight];
const COMMAND_CODES = ["MetaLeft", "MetaRight"];

function keysymForCodePoint(codePoint) {
  if (codePoint === 10 || codePoint === 13) return KEYSYM.enter;
  if (codePoint === 9) return KEYSYM.tab;
  if (codePoint === 8) return KEYSYM.backspace;
  if (codePoint === 27) return KEYSYM.escape;
  if (codePoint === 127) return KEYSYM.delete;
  if (codePoint < 32) return 0;
  if (codePoint < 0x100) return codePoint;
  return 0x1000000 + codePoint;
}

function pasteStrokes(text, most) {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const strokes = [];
  for (let line = 0; line < lines.length; line += 1) {
    if (line > 0) strokes.push([KEYSYM.shift, KEYSYM.enter]);
    for (const character of lines[line].replace(/\t/g, " ")) {
      const keysym = keysymForCodePoint(character.codePointAt(0));
      if (keysym) strokes.push([keysym]);
    }
    if (strokes.length > most) return null;
  }
  return strokes;
}

function commandShortcut(event, letter) {
  if (event.metaKey !== true || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const typed = typeof event.key === "string" ? event.key.toLowerCase() : "";
  return /^[a-z]$/.test(typed) ? typed === letter : event.code === "Key" + letter.toUpperCase();
}

function sendStrokes(client, strokes) {
  for (const stroke of strokes) {
    for (const keysym of stroke) client.sendKey(keysym, null, true);
    for (const keysym of [...stroke].reverse()) client.sendKey(keysym, null, false);
  }
}

function createClipboardBridge(host) {
  let latest = "";
  let commandLetGo = false;
  const commandKeys = new Set();

  function letGoOfCommand(client) {
    if (commandKeys.size === 0) return;
    for (const keysym of COMMAND_HELD) client.sendKey(keysym, null, false);
    commandLetGo = true;
  }

  async function paste() {
    if (host.client() === null) {
      host.note(CLIPBOARD_WORDS.notConnected);
      return;
    }
    let text;
    try {
      text = await host.readText();
    } catch {
      host.note(CLIPBOARD_WORDS.pasteRefused);
      return;
    }
    if (typeof text !== "string" || text.length === 0) {
      host.note(CLIPBOARD_WORDS.nothingToPaste);
      return;
    }
    const client = host.client();
    if (client === null) {
      host.note(CLIPBOARD_WORDS.notConnected);
      return;
    }
    letGoOfCommand(client);
    client.clipboardPasteFrom(text);
    const strokes = pasteStrokes(text, PASTE_TYPED_MOST);
    if (strokes !== null) {
      sendStrokes(client, strokes);
      host.note(CLIPBOARD_WORDS.pasted);
      return;
    }
    host.later(() => {
      if (host.client() !== client) {
        host.note(CLIPBOARD_WORDS.notConnected);
        return;
      }
      sendStrokes(client, [[KEYSYM.control, KEYSYM.v]]);
      host.note(CLIPBOARD_WORDS.pasted);
    }, PASTE_SETTLE_MS);
  }

  function copy() {
    if (latest.length === 0) {
      host.note(CLIPBOARD_WORDS.nothingToCopy);
      return;
    }
    new Promise((resolve) => resolve(host.writeText(latest))).then(() => host.note(CLIPBOARD_WORDS.copied), () => host.note(CLIPBOARD_WORDS.copyRefused));
  }

  function forgetCommand() {
    commandKeys.clear();
    commandLetGo = false;
  }

  return {
    heard(text) {
      if (typeof text === "string" && host.focused()) latest = text;
    },
    keydown(event) {
      if (COMMAND_CODES.includes(event.code)) {
        commandKeys.add(event.code);
        return false;
      }
      const pasting = commandShortcut(event, "v");
      const copying = !pasting && commandShortcut(event, "c");
      if (!pasting && !copying && !(commandLetGo && event.metaKey === true)) return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat === true) return true;
      if (pasting) void paste();
      else if (copying) copy();
      return true;
    },
    keyup(event) {
      if (!COMMAND_CODES.includes(event.code)) return;
      commandKeys.delete(event.code);
      if (commandKeys.size === 0) commandLetGo = false;
    },
    blur: forgetCommand,
  };
}
`;
