# A dog's cloud computer: a Debian desktop the dog drives (xdotool, scrot) and the person watches and takes over
# (noVNC in later.dog's desktop viewer). `wrangler deploy` builds it for linux/amd64; the same file builds natively on
# arm64 for a local smoke test (README.md).
FROM node:24-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 TZ=UTC NO_AT_BRIDGE=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tini sudo ca-certificates curl wget git gh openssh-client procps psmisc less nano unzip xz-utils jq python3 \
    dbus-x11 xvfb x11-utils x11-xserver-utils x11vnc novnc python3-websockify \
    xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-terminal xfce4-settings thunar librsvg2-common \
    chromium fonts-dejavu-core fonts-liberation fonts-noto-color-emoji fonts-wqy-microhei \
    xdotool scrot xclip xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# The dog's account: uid/gid 1000 (the base image's unused "node" user gives way), because the Worker's exec() names users
# by number. Passwordless sudo, like any computer it owns. Commands from later.dog run as this user.
RUN userdel --remove node \
  && useradd --uid 1000 --user-group --create-home --shell /bin/bash --groups sudo dog \
  && printf 'dog ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/dog && chmod 0440 /etc/sudoers.d/dog \
  && ln -sf /usr/bin/chromium /usr/local/bin/google-chrome

COPY --chown=dog:dog xfce/ /home/dog/.config/xfce4/xfconf/xfce-perchannel-xml/
COPY mimeapps.list /etc/xdg/mimeapps.list
COPY chromium-flags /etc/chromium.d/laterdog
COPY start-desktop.sh /usr/local/bin/laterdog-desktop
RUN chmod 0755 /usr/local/bin/laterdog-desktop \
  && cp /etc/xdg/xfce4/panel/default.xml /home/dog/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml \
  && chown -R dog:dog /home/dog/.config

# noVNC (websockify) is the only listener the Worker reaches; VNC itself stays on localhost.
EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/laterdog-desktop"]
