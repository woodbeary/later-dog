#!/bin/bash
set -u
export DISPLAY=:0
GEOMETRY="${DESKTOP_GEOMETRY:-1280x800}"
DOG_RUNTIME=/run/user/1000
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

keep laterdog-websockify --web /usr/share/novnc 0.0.0.0:6080 localhost:5900 &
keep Xvfb :0 -screen 0 "${GEOMETRY}x24" -nolisten tcp -ac -s 0 -dpms &
keep as_dog dbus-daemon --session --address="${BUS}" --nofork --nopidfile &

wait_until() {
  for _ in $(seq 1 500); do "$@" >/dev/null 2>&1 && return 0; sleep 0.02; done
  return 1
}

wait_until xdpyinfo
keep x11vnc -display :0 -forever -shared -nopw -localhost -rfbport 5900 -xkb -noxdamage -quiet &
wait_until test -S "${DOG_RUNTIME}/bus"

xsetroot -solid "#0e1013"
keep as_dog nice -n 10 xfsettingsd --no-daemon &
keep as_dog xfwm4 &
keep as_dog nice -n 10 xfce4-panel &
keep as_dog nice -n 10 xfdesktop &

trap 'kill 0' TERM INT
wait
