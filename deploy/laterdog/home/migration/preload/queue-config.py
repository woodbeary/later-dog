import json
import os
import pathlib
import re
import sys

out = pathlib.Path(sys.argv[1])
policy = json.loads((out / "policy.json").read_bytes())
name = sys.argv[2]
shards = int(sys.argv[3]) if len(sys.argv) > 3 else 1
if not re.fullmatch("[a-z0-9][a-z0-9-]{9,47}", name) or not 1 <= shards <= 32:
    raise ValueError("Invalid private queue service or shard count")
os.umask(0o077)
profile = "queue" if shards == 1 else "parallel"
(out / (profile + ".mjs")).write_bytes(
    pathlib.Path(__file__).with_name("queue.mjs").read_bytes()
)
common = {"account_id": policy["account"], "compatibility_date": "2026-10-01"}
names = [name] if shards == 1 else [name + "-" + str(i).zfill(2) for i in range(shards)]
queues = {
    "producers": [
        {"binding": "JOBS" if shards == 1 else "JOBS_" + str(i), "queue": q}
        for i, q in enumerate(names)
    ],
    "consumers": [
        {
            "queue": q,
            "max_batch_size": 4,
            "max_batch_timeout": 1,
            "max_concurrency": 32 if shards == 1 else 16,
            "max_retries": 25,
        }
        for q in names
    ],
}
config = {
    **common,
    "name": name,
    "main": profile + ".mjs",
    "workers_dev": False,
    "preview_urls": False,
    "routes": [],
    "services": [
        {
            "binding": "COPY",
            "service": policy["service"],
            "entrypoint": "ImmutableFolderCopy",
        }
    ],
    "r2_buckets": [{"binding": "RECEIPTS", "bucket_name": policy["sourceBucket"]}],
    "queues": queues,
}
if shards > 1:
    config["vars"] = {"COPY_QUEUE_SHARDS": str(shards)}
(out / (profile + "-worker.json")).write_text(json.dumps(config))
(out / (profile + "-local.json")).write_text(
    json.dumps(
        {
            **common,
            "name": name + "-mac",
            "services": [
                {
                    "binding": "DISPATCH",
                    "service": name,
                    "entrypoint": "PrivateCopyQueue",
                    "remote": True,
                }
            ],
        }
    )
)
(out / (profile + "-queues.txt")).write_text("\n".join(names) + "\n")
