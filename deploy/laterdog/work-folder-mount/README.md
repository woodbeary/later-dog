# Work-folder mount

The home process mounts an empty directory and forwards filesystem operations over a trusted Unix socket. A helper on the assigned Linux computer opens one existing directory and serves operations against its devices and inodes. Regular file reads and writes carry at most 128 KiB per request. The home mount uses direct I/O and handles at most 32 outstanding requests.

## Build and test

Build the static binary with Go 1.27.4. The module file and sums pin go-fuse and its dependencies. Include `LICENSE.dependencies` with binary distributions.

```sh
TARGETARCH=amd64 ./build.sh /output/laterdog-work-folder-mount
TARGETARCH=arm64 ./build.sh /output/laterdog-work-folder-mount-arm64
LATERDOG_TEST_KERNEL_FUSE=1 go test -count=1 -v ./...
```

The kernel test requires Linux with FUSE, mount permission and access to `/dev/fuse`. Test the actual kernel on the container class used for release.

## Startup

Launch the guest process as the filesystem owner. Bind one transport session to one authorized root.

```sh
laterdog-work-folder-mount --stdio --directory "$directory" --root "$folder_id"
```

Launch the home process with its private adapter socket. Use `--allow-other` when the mount daemon and its authorized reader run under different Linux users. Kernel permission checks use the UID, GID and mode reported by the guest.

```sh
laterdog-work-folder-mount --socket "$socket" --root "$folder_id" --mount "$empty_directory" --allow-other
```

Each process announces `{"ready":true,"version":1}` on standard output after startup. Keep the underlying empty mountpoint inaccessible to the home service until the mount is ready. A transport error returns a filesystem error. Unmounting exposes the original directory.

## Filesystem protocol

The home mount sends JSON in `POST /v1/fs` over the Unix socket. The adapter maps the authorized root to its guest. Each guest input line contains `{"id":1,"request":{...}}`. Each response line contains the same ID plus `"response"`. Reply to the home HTTP request with status 200 and the response object. Only a successful operation has `"ok":true`. Failure has `{"ok":false,"errno":"ENOENT"}` or another Linux errno. Do not retry an ambiguous mutation after receiving a disconnect.

Requests contain `op`, `root` and `path`. The root path is the empty string. Other paths use valid UTF-8 components separated by a single slash. Each component is at most 255 bytes. Directory traversal, escaping links and crossing nested mounts are rejected. Scoped relative symlinks retain their target text. An existing unshareable link stays on the guest. The guest rejects traversals outside its assigned root. For a link into another authorized project, the trusted home adapter can inspect the raw link and verify the destination against its project membership. It must return `projected: true` with a canonical absolute path under `/run/laterdog-work-folders/tree/project-<64 lowercase hex>`. The kernel client checks this shape and each component before returning the link.

| Operation | Extra request fields | Response fields |
| --- | --- | --- |
| getattr | optional handle for an open inode | attr |
| open, create | flags as Linux open bits, mode required for create | handle, attr |
| opendir | flags | handle, attr |
| readdir | directory handle, cursor as decimal entry offset, initially "0" | entries of name, ino, mode; next if another page may exist |
| read | handle, offset and size | data in base64; absent on EOF |
| write | handle, offset and base64 data | written byte count; absent for zero |
| flush, fsync | handle, optional flags for fsync | success after the guest has completed the requested sync |
| release, releasedir | handle | success |
| mkdir | mode | attr |
| symlink, readlink | target on symlink | attr on creation, target on readlink |
| readlinkMetadata (guest stdio only) | none | original raw link text in target, read from the link itself without traversal |
| link | source root-relative path; path names the new link | attr |
| rename | newPath, Linux flags for replace, no-replace or exchange | success |
| unlink, rmdir | none | success |
| setattr | optional handle, optional mode, uid, gid, size, atimeNs or mtimeNs | attr |
| statfs | none | space, with blocks, bfree, bavail, files, ffree, bsize, namelen and frsize |

Inode numbers, offsets, file sizes, nanosecond timestamps, file block counts and the five 64-bit filesystem capacity counters use decimal JSON strings. File attributes include ino, mode (POSIX type and permission bits), size, blocks, atimeNs, mtimeNs, ctimeNs, nlink, uid and gid. An empty result may omit optional zero-value members. Directory pages include up to 64 entries. A directory handle keeps its inode even when its name changes. The guest rejects stale file handles after restart. Use the same guest session for a handle's entire lifetime and never translate a stale descriptor into a path.

The adapter owns authorization, durable R2 publication, and cold-data selection. A guest fsync establishes local Linux durability. When a caller needs R2 durability, the adapter must wait for the corresponding publication before acknowledging it. Native provider credentials remain outside the shared directory. Name and mode checks on the home mount supplement the guest's descriptor-anchored Linux `openat2` scope.
