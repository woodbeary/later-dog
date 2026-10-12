#!/bin/sh
set -eu

case "${1:-}" in
  remove|purge) ;;
  *) exit 0 ;;
esac

if [ -n "${LATERDOG_POSTINSTALL_TEST_ROOT:-}" ]; then
  TEST_ROOT="$(realpath -e -- "$LATERDOG_POSTINSTALL_TEST_ROOT")"
  case "$TEST_ROOT" in
    /tmp/*) ;;
    *) echo "later.dog test install root must stay under /tmp" >&2; exit 1 ;;
  esac
  APPARMOR_DIR=$TEST_ROOT/test-system/apparmor.d
  APPARMOR_PARSER=$TEST_ROOT/test-system/apparmor_parser
  APPARMOR_STATUS=$TEST_ROOT/test-system/apparmor_status
  APPARMOR_PROFILES=$TEST_ROOT/test-system/apparmor-profiles
  TEST_MODE=1
else
  APPARMOR_DIR=/etc/apparmor.d
  APPARMOR_PARSER=/sbin/apparmor_parser
  APPARMOR_STATUS=/sbin/apparmor_status
  APPARMOR_PROFILES=/sys/kernel/security/apparmor/profiles
  TEST_MODE=0
fi

if [ "$TEST_MODE" -eq 0 ]; then
  if command -v update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove laterdog /opt/later.dog/laterdog
  elif [ -L /usr/bin/laterdog ] && [ "$(readlink /usr/bin/laterdog)" = /opt/later.dog/laterdog ]; then
    rm -- /usr/bin/laterdog
  fi
fi

profile=$APPARMOR_DIR/laterdog-browser
if [ ! -e "$profile" ] && [ ! -L "$profile" ]; then exit 0; fi
if [ -L "$APPARMOR_DIR" ] || [ -L "$profile" ] || [ ! -f "$profile" ]; then
  echo "later.dog AppArmor profile is unsafe; refusing to remove it: $profile" >&2
  exit 1
fi
if [ "$TEST_MODE" -eq 0 ] && [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; then
  :
elif [ -x "$APPARMOR_STATUS" ] && ! "$APPARMOR_STATUS" --enabled >/dev/null 2>&1; then
  :
elif [ -r "$APPARMOR_PROFILES" ] && ! grep -q '^laterdog-browser ' "$APPARMOR_PROFILES"; then
  :
elif [ -x "$APPARMOR_PARSER" ]; then
  if ! "$APPARMOR_PARSER" -R "$profile"; then
    echo "later.dog could not unload its browser AppArmor profile: $profile" >&2
    exit 1
  fi
elif [ -r "$APPARMOR_PROFILES" ]; then
  echo "later.dog needs apparmor_parser to unload its browser profile: $profile" >&2
  exit 1
fi
rm -- "$profile"
