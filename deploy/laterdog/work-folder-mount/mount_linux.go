package main

import (
	"context"
	"os"
	"path"
	"strconv"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
	"golang.org/x/sys/unix"
)

type node struct {
	fs.Inode
	api *adapter
}

func (n *node) name() string { return n.Path(n.Root()) }
func (n *node) child(name string) (string, syscall.Errno) {
	if !component(name) {
		return "", unix.EINVAL
	}
	v := path.Join(n.name(), name)
	if !validPath(v) {
		return "", unix.ENAMETOOLONG
	}
	return v, 0
}

func useAttr(r response, e syscall.Errno, out *fuse.Attr) syscall.Errno {
	if e != 0 {
		return e
	}
	a := r.Attr
	if a == nil || a.Ino == 0 || a.Nlink > 1<<32-1 || a.Size < 0 || a.Blocks < 0 {
		return unix.EIO
	}
	out.Ino = a.Ino
	out.Size = uint64(a.Size)
	out.Blocks = uint64(a.Blocks)
	out.Mode = a.Mode
	out.Nlink = uint32(a.Nlink)
	out.Uid = a.UID
	out.Gid = a.GID
	out.Blksize = 4096
	at, mt, ct := time.Unix(0, a.Atime), time.Unix(0, a.Mtime), time.Unix(0, a.Ctime)
	out.SetTimes(&at, &mt, &ct)
	return 0
}

func (n *node) entry(ctx context.Context, r response, e syscall.Errno, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if err := useAttr(r, e, &out.Attr); err != 0 {
		return nil, err
	}
	return n.NewInode(ctx, &node{api: n.api}, fs.StableAttr{Mode: out.Mode & unix.S_IFMT, Ino: out.Ino}), 0
}

func (n *node) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	child, e := n.child(name)
	if e != 0 {
		return nil, e
	}
	r, e := n.api.call(ctx, request{Op: "getattr", Path: child})
	return n.entry(ctx, r, e, out)
}

func (n *node) Getattr(ctx context.Context, f fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	if h, ok := f.(fs.FileGetattrer); ok {
		return h.Getattr(ctx, out)
	}
	r, e := n.api.call(ctx, request{Op: "getattr", Path: n.name()})
	return useAttr(r, e, &out.Attr)
}

func changeReq(in *fuse.SetAttrIn) request {
	r := request{Op: "setattr"}
	if v, ok := in.GetSize(); ok {
		size := int64(v)
		r.Size = &size
	}
	if v, ok := in.GetMode(); ok {
		r.Mode = &v
	}
	if v, ok := in.GetUID(); ok {
		r.UID = &v
	}
	if v, ok := in.GetGID(); ok {
		r.GID = &v
	}
	if v, ok := in.GetATime(); ok {
		stamp := v.UnixNano()
		r.Atime = &stamp
	}
	if v, ok := in.GetMTime(); ok {
		stamp := v.UnixNano()
		r.Mtime = &stamp
	}
	return r
}

func (n *node) Setattr(ctx context.Context, f fs.FileHandle, in *fuse.SetAttrIn, out *fuse.AttrOut) syscall.Errno {
	if h, ok := f.(fs.FileSetattrer); ok {
		return h.Setattr(ctx, in, out)
	}
	q := changeReq(in)
	q.Path = n.name()
	r, e := n.api.call(ctx, q)
	return useAttr(r, e, &out.Attr)
}

func (n *node) newEntry(ctx context.Context, name string, q request, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	child, e := n.child(name)
	if e != 0 {
		return nil, e
	}
	q.Path = child
	r, e := n.api.call(ctx, q)
	return n.entry(ctx, r, e, out)
}

func (n *node) Mkdir(ctx context.Context, name string, mode uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	return n.newEntry(ctx, name, request{Op: "mkdir", Mode: &mode}, out)
}
func (n *node) Link(ctx context.Context, target fs.InodeEmbedder, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	return n.newEntry(ctx, name, request{Op: "link", Source: target.EmbeddedInode().Path(n.Root())}, out)
}
func (n *node) Symlink(ctx context.Context, target, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	return n.newEntry(ctx, name, request{Op: "symlink", Target: target}, out)
}
func (n *node) Readlink(ctx context.Context) ([]byte, syscall.Errno) {
	r, e := n.api.call(ctx, request{Op: "readlink", Path: n.name()})
	if e != 0 {
		return nil, e
	}
	if !safeTarget(n.name(), r.Target) && !(r.Projected && projectedTarget(r.Target)) {
		return nil, unix.EACCES
	}
	return []byte(r.Target), 0
}

func (n *node) remove(ctx context.Context, name, op string) syscall.Errno {
	child, e := n.child(name)
	if e != 0 {
		return e
	}
	_, e = n.api.call(ctx, request{Op: op, Path: child})
	return e
}
func (n *node) Unlink(ctx context.Context, name string) syscall.Errno {
	return n.remove(ctx, name, "unlink")
}
func (n *node) Rmdir(ctx context.Context, name string) syscall.Errno {
	return n.remove(ctx, name, "rmdir")
}
func (n *node) Rename(ctx context.Context, name string, parent fs.InodeEmbedder, newName string, flags uint32) syscall.Errno {
	src, e := n.child(name)
	if e != 0 {
		return e
	}
	dest, e := parent.(*node).child(newName)
	if e != 0 {
		return e
	}
	_, e = n.api.call(ctx, request{Op: "rename", Path: src, NewPath: dest, Flags: flags})
	return e
}

func (n *node) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	name := n.name()
	r, e := n.api.call(ctx, request{Op: "open", Path: name, Flags: flags})
	if e != 0 {
		return nil, 0, e
	}
	if r.Handle == "" {
		return nil, 0, unix.EIO
	}
	return &remoteFile{api: n.api, key: r.Handle, folder: name}, fuse.FOPEN_DIRECT_IO, 0
}
func (n *node) Create(ctx context.Context, name string, flags, mode uint32, out *fuse.EntryOut) (*fs.Inode, fs.FileHandle, uint32, syscall.Errno) {
	child, e := n.child(name)
	if e != 0 {
		return nil, nil, 0, e
	}
	r, e := n.api.call(ctx, request{Op: "create", Path: child, Flags: flags, Mode: &mode})
	inode, e := n.entry(ctx, r, e, out)
	if e != 0 {
		return nil, nil, 0, e
	}
	if r.Handle == "" {
		return nil, nil, 0, unix.EIO
	}
	return inode, &remoteFile{api: n.api, key: r.Handle, folder: child}, fuse.FOPEN_DIRECT_IO, 0
}

func (n *node) OpendirHandle(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	name := n.name()
	r, e := n.api.call(ctx, request{Op: "opendir", Path: name, Flags: flags})
	if e != 0 {
		return nil, 0, e
	}
	if r.Handle == "" {
		return nil, 0, unix.EIO
	}
	return &remoteDir{remoteFile: remoteFile{api: n.api, key: r.Handle, folder: name}}, 0, 0
}
func (d *remoteDir) Readdirent(ctx context.Context) (*fuse.DirEntry, syscall.Errno) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.page) == 0 {
		if d.end {
			return nil, 0
		}
		r, e := d.call(ctx, request{Op: "readdir", Cursor: strconv.FormatUint(d.position, 10)})
		if e != 0 {
			return nil, e
		}
		if len(r.Entries) > pageSize || (r.Next != "" && r.Next != strconv.FormatUint(d.position+uint64(len(r.Entries)), 10)) {
			return nil, unix.EIO
		}
		d.end = r.Next == ""
		if len(r.Entries) == 0 {
			if !d.end {
				return nil, unix.EIO
			}
			return nil, 0
		}
		d.page = r.Entries
	}
	item := d.page[0]
	d.page = d.page[1:]
	d.position++
	if !component(item.Name) || item.Ino == 0 {
		return nil, unix.EIO
	}
	return &fuse.DirEntry{Name: item.Name, Mode: item.Mode, Ino: item.Ino, Off: d.position}, 0
}
func (d *remoteDir) Seekdir(ctx context.Context, off uint64) syscall.Errno {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.position = off
	d.page = nil
	d.end = false
	return 0
}
func (d *remoteDir) Fsyncdir(ctx context.Context, flags uint32) syscall.Errno {
	return d.Fsync(ctx, flags)
}
func (d *remoteDir) Releasedir(ctx context.Context, flags uint32) {
	d.call(ctx, request{Op: "releasedir"})
}

func (f *remoteFile) Getattr(ctx context.Context, out *fuse.AttrOut) syscall.Errno {
	r, e := f.call(ctx, request{Op: "getattr"})
	return useAttr(r, e, &out.Attr)
}
func (f *remoteFile) Setattr(ctx context.Context, in *fuse.SetAttrIn, out *fuse.AttrOut) syscall.Errno {
	r, e := f.call(ctx, changeReq(in))
	return useAttr(r, e, &out.Attr)
}
func (f *remoteFile) Read(ctx context.Context, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	size := int64(min(len(dest), maxChunk))
	r, e := f.call(ctx, request{Op: "read", Offset: off, Size: &size})
	if e != 0 {
		return nil, e
	}
	if int64(len(r.Data)) > size {
		return nil, unix.EIO
	}
	return fuse.ReadResultData(r.Data), 0
}
func (f *remoteFile) Write(ctx context.Context, data []byte, off int64) (uint32, syscall.Errno) {
	if len(data) > maxChunk {
		return 0, unix.E2BIG
	}
	r, e := f.call(ctx, request{Op: "write", Offset: off, Data: data})
	if e != 0 {
		return 0, e
	}
	if r.Written < 0 || r.Written > len(data) {
		return 0, unix.EIO
	}
	return uint32(r.Written), 0
}
func (f *remoteFile) Flush(ctx context.Context) syscall.Errno {
	_, e := f.call(ctx, request{Op: "flush"})
	return e
}
func (f *remoteFile) Fsync(ctx context.Context, flags uint32) syscall.Errno {
	_, e := f.call(ctx, request{Op: "fsync", Flags: flags})
	return e
}
func (f *remoteFile) Release(ctx context.Context) syscall.Errno {
	_, e := f.call(ctx, request{Op: "release"})
	return e
}
func (n *node) Statfs(ctx context.Context, out *fuse.StatfsOut) syscall.Errno {
	r, e := n.api.call(ctx, request{Op: "statfs", Path: n.name()})
	if e != 0 {
		return e
	}
	s := r.Space
	if s == nil {
		return unix.EIO
	}
	*out = fuse.StatfsOut{Blocks: s.Blocks, Bfree: s.Bfree, Bavail: s.Bavail, Files: s.Files, Ffree: s.Ffree, Bsize: s.Bsize, NameLen: s.Namelen, Frsize: s.Frsize}
	return 0
}

func mount(ctx context.Context, directory string, api *adapter, allowOther bool) (*fuse.Server, error) {
	entries, e := os.ReadDir(directory)
	if e != nil {
		return nil, e
	}
	if len(entries) != 0 {
		return nil, unix.ENOTEMPTY
	}
	r, status := api.call(ctx, request{Op: "getattr"})
	if status != 0 {
		return nil, status
	}
	if r.Attr == nil || r.Attr.Mode&unix.S_IFMT != unix.S_IFDIR || r.Attr.Ino == 0 {
		return nil, unix.EIO
	}
	zero := time.Duration(0)
	opts := &fs.Options{MountOptions: fuse.MountOptions{Name: "laterdog-work-folder", FsName: api.root, AllowOther: allowOther, Options: []string{"default_permissions", "nosuid", "nodev"}, DirectMount: true, ExtraCapabilities: fuse.CAP_DIRECT_IO_ALLOW_MMAP, MaxWrite: maxChunk, MaxReadAhead: maxChunk, DisableReadDirPlus: true, DisableXAttrs: true},
		RootStableAttr: &fs.StableAttr{Ino: r.Attr.Ino, Mode: unix.S_IFDIR}, AttrTimeout: &zero, EntryTimeout: &zero, NegativeTimeout: &zero, NullPermissions: true}
	return fs.Mount(directory, &node{api: api}, opts)
}
