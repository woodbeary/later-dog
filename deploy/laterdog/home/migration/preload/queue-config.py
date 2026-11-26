import json, pathlib, sys, os

out = pathlib.Path(sys.argv[1])
policy = json.loads((out / "policy.json").read_bytes())
name = sys.argv[2]
assert (
    len(name) >= 10
    and len(name) <= 48
    and all(c.isascii() and (c.isalnum() or c == "-") for c in name)
)
os.umask(0o077)
(out / "queue.mjs").write_bytes(
    pathlib.Path(__file__).with_name("queue.mjs").read_bytes()
)
common = {"account_id": policy["account"], "compatibility_date": "2026-10-01"}
(out / "queue-worker.json").write_text(
    json.dumps(
        {
            **common,
            "name": name,
            "main": "queue.mjs",
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
            "r2_buckets": [
                {"binding": "RECEIPTS", "bucket_name": policy["sourceBucket"]}
            ],
            "queues": {
                "producers": [{"binding": "JOBS", "queue": name}],
                "consumers": [
                    {
                        "queue": name,
                        "max_batch_size": 4,
                        "max_batch_timeout": 1,
                        "max_concurrency": 32,
                        "max_retries": 25,
                    }
                ],
            },
        }
    )
)
(out / "queue-local.json").write_text(
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
