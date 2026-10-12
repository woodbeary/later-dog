const HELPERS = "/home/dog/.local/share/xfce4/helpers";
const HELPERS_RC = "/home/dog/.config/xfce4/helpers.rc";

const HELPER_LINES = [
  "[Desktop Entry]",
  "NoDisplay=true",
  "Version=1.0",
  "Encoding=UTF-8",
  "Type=X-XFCE-Helper",
  "X-XFCE-Category=WebBrowser",
  'X-XFCE-CommandsWithParameter=/usr/bin/chromium "%s"',
  "Icon=chromium",
  "Name=Chromium",
  "X-XFCE-Commands=/usr/bin/chromium",
];

const quoted = (line: string) => `'${line.replaceAll("'", `'\\''`)}'`;

export const BROWSER_DEFAULT_SCRIPT = [
  `mkdir -p ${HELPERS} /home/dog/.config/xfce4 || exit 1`,
  `[ -s ${HELPERS_RC} ] || printf 'WebBrowser=custom-WebBrowser\\n' > ${HELPERS_RC} || exit 1`,
  `[ -s ${HELPERS}/custom-WebBrowser.desktop ] || printf '%s\\n' ${HELPER_LINES.map(quoted).join(" ")} > ${HELPERS}/custom-WebBrowser.desktop`,
].join("\n");
