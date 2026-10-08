#!/bin/bash
# Starts the dog's desktop: display :0 (Xvfb), a session D-Bus and XFCE as the dog user, a VNC server on localhost and
# noVNC on :6080. A computer restored from a snapshot runs this again over the snapshot's files, so leftovers of the
# previous boot (X and bus sockets, Chromium's profile lock) are cleared first.
# Each piece restarts on its own if it exits; the container stops only when the platform stops it.
set -u
export DISPLAY=:0
GEOMETRY="${DESKTOP_GEOMETRY:-1280x800}"
DOG_RUNTIME=/run/user/1000
# The Worker passes the same address to every command it runs, so commands and the desktop share one session bus.
BUS="unix:path=${DOG_RUNTIME}/bus"

rm -f /tmp/.X0-lock /tmp/.X11-unix/X0 "${DOG_RUNTIME}/bus"
rm -f /home/dog/.config/chromium/SingletonLock /home/dog/.config/chromium/SingletonSocket /home/dog/.config/chromium/SingletonCookie
mkdir -p /tmp/.X11-unix /tmp/.ICE-unix && chmod 1777 /tmp/.X11-unix /tmp/.ICE-unix
mkdir -p "${DOG_RUNTIME}" && chown dog:dog "${DOG_RUNTIME}" && chmod 0700 "${DOG_RUNTIME}"

keep() {
  while true; do
    "$@"
    echo "laterdog-desktop: '$*' exited with $?, restarting" >&2
    sleep 1
  done
}

as_dog() {
  runuser -u dog -- env HOME=/home/dog USER=dog LOGNAME=dog SHELL=/bin/bash DISPLAY=:0 \
    XDG_RUNTIME_DIR="${DOG_RUNTIME}" DBUS_SESSION_BUS_ADDRESS="${BUS}" NO_AT_BRIDGE=1 "$@"
}

keep Xvfb :0 -screen 0 "${GEOMETRY}x24" -nolisten tcp -ac &
for _ in $(seq 1 100); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done

keep as_dog dbus-daemon --session --address="${BUS}" --nofork --nopidfile &
for _ in $(seq 1 50); do [ -S "${DOG_RUNTIME}/bus" ] && break; sleep 0.1; done

keep as_dog startxfce4 &
keep x11vnc -display :0 -forever -shared -nopw -localhost -rfbport 5900 -xkb -noxdamage -quiet &
keep websockify --web /usr/share/novnc 0.0.0.0:6080 localhost:5900 &

trap 'kill 0' TERM INT
wait
