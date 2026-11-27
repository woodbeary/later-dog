import hashlib
import json
from legacy import CHUNK, digest, encode, hash_name, file_bytes, require

DIRECTORY = ".laterdog/.backups/cloud-previous/"
ARCHIVE = DIRECTORY + "workspace.dogbackup"
REFERENCE = DIRECTORY + "backup-reference.json"
DESCRIPTION = DIRECTORY + "previous.json"


def saved_blob(transport, h):
    st, _, b = transport.admin("blobs/" + hash_name(h))
    require(
        st == 200 and digest(b) == h,
        "Previous backup references a missing coordinator blob",
    )
    return b


def put_blob(transport, data):
    h = digest(data)
    st, _, _ = transport.admin("blobs/" + h, "PUT", data)
    require(
        200 <= st < 300 and saved_blob(transport, h) == data,
        "Previous backup blob readback differs",
    )
    return h


def stage_reference(transport, source, retain=False):
    rows = {
        e["path"]: e
        for e in json.loads(source)["entries"]
        if e["path"].startswith(DIRECTORY)
    }
    original = rows.get(ARCHIVE)
    if not original or DESCRIPTION not in rows or REFERENCE in rows:
        return
    require(
        original["type"] == "file" and rows[DESCRIPTION]["type"] == "file",
        "Conflicting previous backup metadata",
    )
    marker = put_blob(
        transport,
        encode(
            {
                "v": 1,
                "source": "baseline",
                "baseline": digest(source),
                "size": original["size"],
            }
        ),
    )
    if retain:
        page = digest(encode(["leaf", [marker]]))
        st, _, response = transport.admin("work-folders/retention/leaf/" + page, "POST", {"hashes": [marker]})
        require(st == 200 and json.loads(response).get("revision") == page, "Previous backup reference was not retained")


def restore_reference(rows, baseline, original, transport):
    marker = rows.get(REFERENCE)
    if not marker:
        return
    require(marker["type"] == "file", "Invalid previous backup reference")
    body = b"".join(file_bytes(marker, lambda h: saved_blob(transport, h)))
    ref = json.loads(body)
    require(
        ref.get("v") == 1 and type(ref.get("size")) is int and ref["size"] >= 0,
        "Invalid previous backup reference",
    )
    require(
        DESCRIPTION in rows
        and rows[DESCRIPTION]["type"] == "file"
        and ARCHIVE not in rows,
        "Inconsistent current previous backup records",
    )
    if ref.get("source") == "baseline":
        require(
            ref.get("baseline") == baseline
            and original.get(ARCHIVE, {}).get("size") == ref["size"],
            "Previous backup points to another snapshot",
        )
        output = original[ARCHIVE]
    elif ref.get("source") == "archive":
        chunks = ref.get("chunks")
        size = ref["size"]
        whole = hash_name(ref.get("sha256"))
        hash_name(ref.get("signature"))
        require(
            isinstance(chunks, list)
            and len(chunks) == (size + CHUNK - 1) // CHUNK
            and all(hash_name(h) for h in chunks),
            "Invalid previous backup chunk sequence",
        )
        status, _, result = transport.admin(
            "work-folders/verify-previous-backup", "POST", ref
        )
        require(
            status == 200 and json.loads(result).get("verified") is True,
            "Previous backup signature does not match this home",
        )
        total = hashlib.sha256()
        for i, h in enumerate(chunks):
            st, _, b = transport.admin("archive/blobs/" + h)
            require(
                st == 200 and len(b) == min(CHUNK, size - i * CHUNK) and digest(b) == h,
                "Archived previous backup bytes differ",
            )
            total.update(b)
            require(put_blob(transport, b) == h, "Archived backup projection changed")
        require(
            total.hexdigest() == whole, "Previous backup full-content checksum differs"
        )
        output = {
            "path": ARCHIVE,
            "type": "file",
            "mode": 0o600,
            "mtimeMs": marker.get("mtimeMs", 0),
            "size": size,
            "chunks": chunks,
        }
    else:
        raise ValueError("Unknown previous backup reference")
    rows[ARCHIVE] = output
    del rows[REFERENCE]
