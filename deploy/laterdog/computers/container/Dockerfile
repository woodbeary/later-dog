FROM node:24-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 TZ=UTC NO_AT_BRIDGE=1

RUN mkdir -p /tmp/nodejs/DEBIAN \
  && printf 'Package: nodejs\nVersion: %s\nArchitecture: all\nMaintainer: later.dog\nProvides: node\nDescription: Node.js from the base image\n' "$NODE_VERSION" > /tmp/nodejs/DEBIAN/control \
  && dpkg-deb --build /tmp/nodejs /tmp/nodejs.deb \
  && dpkg -i /tmp/nodejs.deb \
  && rm -rf /tmp/nodejs /tmp/nodejs.deb \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    tini sudo ca-certificates curl wget git gh openssh-client procps psmisc less nano unzip xz-utils jq python3 \
  && rm -rf /var/lib/apt/lists/*

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium fonts-dejavu-core fonts-liberation fonts-noto-color-emoji fonts-wqy-microhei \
  && rm -rf /var/lib/apt/lists/*

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    dbus-x11 xvfb x11-utils x11-xserver-utils x11vnc novnc python3-websockify \
    xfwm4 xfce4-panel xfdesktop4 xfce4-terminal xfce4-settings thunar librsvg2-common \
    xdotool scrot xclip xdg-utils \
  && rm -f /usr/share/applications/xfce-display-settings.desktop /usr/share/applications/x11vnc.desktop \
  && rm -rf /var/lib/apt/lists/*

RUN userdel --remove node \
  && useradd --uid 1000 --user-group --create-home --shell /bin/bash --groups sudo dog \
  && printf 'dog ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/dog && chmod 0440 /etc/sudoers.d/dog \
  && ln -sf /usr/bin/chromium /usr/local/bin/google-chrome

COPY xfce-system/xfce4-keyboard-shortcuts.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-keyboard-shortcuts.xml
COPY mimeapps.list /etc/xdg/mimeapps.list
COPY chromium-flags /etc/chromium.d/laterdog
COPY chromium-policy.json /etc/chromium/policies/managed/laterdog.json
COPY start-desktop.sh /usr/local/bin/laterdog-desktop
COPY laterdog-websockify /usr/local/bin/laterdog-websockify
COPY --chown=dog:dog xfce/ /home/dog/.config/xfce4/xfconf/xfce-perchannel-xml/
COPY --chown=dog:dog xfce-helpers/helpers.rc /home/dog/.config/xfce4/helpers.rc
COPY --chown=dog:dog xfce-helpers/custom-WebBrowser.desktop /home/dog/.local/share/xfce4/helpers/custom-WebBrowser.desktop
COPY --chown=dog:dog panel-launchers/browser.desktop /home/dog/.config/xfce4/panel/launcher-11/browser.desktop
RUN chmod 0755 /usr/local/bin/laterdog-desktop /usr/local/bin/laterdog-websockify \
  && chown -R dog:dog /home/dog/.config /home/dog/.local

EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/laterdog-desktop"]
