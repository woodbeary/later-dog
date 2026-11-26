export const DETACHED_JOB_PROBE = String.raw`import os, re
from pathlib import Path

logs = Path("/home/dog/runs/.logs")
for process in os.scandir("/proc"):
    if not process.name.isdecimal():
        continue
    descriptor = Path(process.path, "fd/9")
    try:
        lock = Path(os.readlink(descriptor))
        if lock.parent != logs or not re.fullmatch(r"[0-9a-f]{8}\.lock", lock.name):
            continue
        group = lock.with_suffix(".pgid")
        if lock.with_suffix(".exit").exists() or not group.is_file() or group.is_symlink():
            continue
        if lock.is_symlink() or not lock.is_file() or not lock.samefile(descriptor):
            continue
        with group.open("rb") as stored:
            pgid = stored.read(24).strip()
        if pgid.isdigit() and int(pgid) > 1 and os.getpgid(int(process.name)) == int(pgid):
            print("running")
            break
    except (OSError, ValueError):
        continue`;
