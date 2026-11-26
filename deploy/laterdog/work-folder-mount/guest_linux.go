package main

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

type descriptor struct {
	file     *os.File
	dir      bool
	writable bool
	position int64
}

type guest struct {
	fd       int
	root     string
	next     uint64
	instance string
	files    map[string]*descriptor
}

func newGuest(directory, root string) (*guest, error) {
	fd, err := unix.Open(directory, unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	g := &guest{fd: fd, root: root, instance: rand.Text(), files: make(map[string]*descriptor)}
	probe, err := g.open("", unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		unix.Close(fd)
		return nil, err
	}
	unix.Close(probe)
	return g, nil
}

func (g *guest) close() {
	for _, d := range g.files {
		d.file.Close()
	}
	unix.Close(g.fd)
}

func (g *guest) open(name string, flags int, mode uint32) (int, error) {
	if name == "" {
		name = "."
	}
	return unix.Openat2(g.fd, name, &unix.OpenHow{Flags: uint64(flags | unix.O_CLOEXEC), Mode: uint64(mode), Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV})
}

func (g *guest) parent(name string) (int, string, error) {
	if name == "" || !validPath(name) {
		return -1, "", unix.EINVAL
	}
	dir, leaf := path.Split(name)
	fd, err := g.open(strings.TrimSuffix(dir, "/"), unix.O_PATH|unix.O_DIRECTORY, 0)
	return fd, leaf, err
}

func attributes(fd int) (*attr, error) {
	var s unix.Stat_t
	if err := unix.Fstat(fd, &s); err != nil {
		return nil, err
	}
	return &attr{Ino: s.Ino, Mode: s.Mode, Size: s.Size, Atime: s.Atim.Nano(), Mtime: s.Mtim.Nano(), Ctime: s.Ctim.Nano(), Nlink: uint64(s.Nlink), UID: s.Uid, GID: s.Gid, Blocks: s.Blocks}, nil
}

func (g *guest) stat(name string) (*attr, error) {
	fd, err := g.open(name, unix.O_PATH|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	return attributes(fd)
}

func (g *guest) get(r request) (*descriptor, error) {
	if d := g.files[r.Handle]; d != nil {
		return d, nil
	}
	return nil, unix.EBADF
}

func (g *guest) openHandle(r request) (response, error) {
	if len(g.files) >= 8192 {
		return response{}, unix.EMFILE
	}
	flag := int(r.Flags) & (unix.O_ACCMODE | unix.O_APPEND | unix.O_TRUNC | unix.O_SYNC | unix.O_DSYNC | unix.O_NOFOLLOW | unix.O_DIRECTORY)
	mode := uint32(0)
	if r.Op == "opendir" {
		flag = unix.O_RDONLY | unix.O_DIRECTORY
	}
	if r.Op == "create" {
		if r.Mode == nil || r.Path == "" {
			return response{}, unix.EINVAL
		}
		mode = *r.Mode & 07777
		flag |= unix.O_CREAT | int(r.Flags)&unix.O_EXCL
	}
	fd, err := g.open(r.Path, flag|unix.O_NONBLOCK, mode)
	if err != nil {
		return response{}, err
	}
	a, err := attributes(fd)
	if err != nil {
		unix.Close(fd)
		return response{}, err
	}
	dir := a.Mode&unix.S_IFMT == unix.S_IFDIR
	if r.Op != "opendir" && a.Mode&unix.S_IFMT != unix.S_IFREG {
		unix.Close(fd)
		if dir {
			return response{}, unix.EISDIR
		}
		return response{}, unix.EPERM
	}
	g.next++
	key := g.instance + "-" + strconv.FormatUint(g.next, 10)
	g.files[key] = &descriptor{file: os.NewFile(uintptr(fd), r.Path), dir: dir, writable: flag&unix.O_ACCMODE != unix.O_RDONLY}
	return response{Attr: a, Handle: key}, nil
}

func (g *guest) entryOperation(r request) (response, error) {
	parent, leaf, err := g.parent(r.Path)
	if err != nil {
		return response{}, err
	}
	defer unix.Close(parent)
	switch r.Op {
	case "mkdir":
		if r.Mode == nil {
			return response{}, unix.EINVAL
		}
		err = unix.Mkdirat(parent, leaf, *r.Mode&07777)
	case "unlink", "rmdir":
		flags := 0
		if r.Op == "rmdir" {
			flags = unix.AT_REMOVEDIR
		}
		return response{}, unix.Unlinkat(parent, leaf, flags)
	case "rename":
		other, to, e := g.parent(r.NewPath)
		if e != nil {
			return response{}, e
		}
		defer unix.Close(other)
		if r.Flags & ^uint32(unix.RENAME_NOREPLACE|unix.RENAME_EXCHANGE) != 0 {
			return response{}, unix.EINVAL
		}
		return response{}, unix.Renameat2(parent, leaf, other, to, uint(r.Flags))
	case "link":
		from, source, e := g.parent(r.Source)
		if e != nil {
			return response{}, e
		}
		defer unix.Close(from)
		err = unix.Linkat(from, source, parent, leaf, 0)
	case "symlink":
		if !safeTarget(r.Path, r.Target) {
			return response{}, unix.EACCES
		}
		err = unix.Symlinkat(r.Target, parent, leaf)
	case "readlink":
		var b [4096]byte
		n, e := unix.Readlinkat(parent, leaf, b[:])
		if e != nil {
			return response{}, e
		}
		target := string(b[:n])
		if !safeTarget(r.Path, target) {
			return response{}, unix.EACCES
		}
		return response{Target: target}, nil
	}
	if err != nil {
		return response{}, err
	}
	a, e := g.stat(r.Path)
	return response{Attr: a}, e
}

func (g *guest) directory(r request, d *descriptor) (response, error) {
	if !d.dir {
		return response{}, unix.ENOTDIR
	}
	cursor := int64(0)
	if r.Cursor != "" {
		value, err := strconv.ParseInt(r.Cursor, 10, 64)
		if err != nil || value < 0 {
			return response{}, unix.EINVAL
		}
		cursor = value
	}
	if cursor != d.position {
		if _, err := d.file.Seek(0, 0); err != nil {
			return response{}, err
		}
		d.position = 0
		for d.position < cursor {
			step := min(int64(pageSize), cursor-d.position)
			items, e := d.file.ReadDir(int(step))
			if e != nil || int64(len(items)) != step {
				return response{}, unix.EINVAL
			}
			d.position += int64(len(items))
		}
	}
	items, e := d.file.ReadDir(pageSize)
	if e != nil && !errors.Is(e, io.EOF) {
		return response{}, e
	}
	out := response{}
	for _, item := range items {
		if !component(item.Name()) {
			return response{}, unix.EILSEQ
		}
		var s unix.Stat_t
		if err := unix.Fstatat(int(d.file.Fd()), item.Name(), &s, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return response{}, err
		}
		out.Entries = append(out.Entries, entry{Name: item.Name(), Ino: s.Ino, Mode: s.Mode})
	}
	d.position += int64(len(items))
	if len(items) == pageSize {
		out.Next = strconv.FormatInt(d.position, 10)
	}
	return out, nil
}

func (g *guest) change(r request) (response, error) {
	var fd int
	if r.Handle != "" {
		d, err := g.get(r)
		if err != nil {
			return response{}, err
		}
		fd = int(d.file.Fd())
	} else {
		flags := unix.O_PATH
		if r.Size != nil {
			flags = unix.O_WRONLY | unix.O_NONBLOCK
		}
		v, e := g.open(r.Path, flags|unix.O_NOFOLLOW, 0)
		if e != nil {
			return response{}, e
		}
		fd = v
		defer unix.Close(fd)
	}
	if r.UID != nil || r.GID != nil {
		uid, gid := -1, -1
		if r.UID != nil {
			uid = int(*r.UID)
		}
		if r.GID != nil {
			gid = int(*r.GID)
		}
		if err := unix.Fchownat(fd, "", uid, gid, unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return response{}, err
		}
	}
	if r.Mode != nil {
		if err := unix.Fchmodat(fd, "", *r.Mode&07777, unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return response{}, err
		}
	}
	if r.Size != nil {
		if *r.Size < 0 {
			return response{}, unix.EINVAL
		}
		if err := unix.Ftruncate(fd, *r.Size); err != nil {
			return response{}, err
		}
	}
	if r.Atime != nil || r.Mtime != nil {
		times := []unix.Timespec{{Nsec: unix.UTIME_OMIT}, {Nsec: unix.UTIME_OMIT}}
		if r.Atime != nil {
			times[0] = unix.NsecToTimespec(*r.Atime)
		}
		if r.Mtime != nil {
			times[1] = unix.NsecToTimespec(*r.Mtime)
		}
		if err := unix.UtimesNanoAt(fd, "", times, unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return response{}, err
		}
	}
	a, err := attributes(fd)
	return response{Attr: a}, err
}

func (g *guest) execute(r request) (response, error) {
	if !validPath(r.Path) || r.Root == "" || (g.root != "" && g.root != r.Root) {
		return response{}, unix.EACCES
	}
	if g.root == "" {
		g.root = r.Root
	}
	switch r.Op {
	case "getattr":
		if r.Handle != "" {
			d, err := g.get(r)
			if err != nil {
				return response{}, err
			}
			a, e := attributes(int(d.file.Fd()))
			return response{Attr: a}, e
		}
		a, e := g.stat(r.Path)
		return response{Attr: a}, e
	case "setattr":
		return g.change(r)
	case "open", "create", "opendir":
		return g.openHandle(r)
	case "mkdir", "unlink", "rmdir", "rename", "link", "symlink", "readlink":
		return g.entryOperation(r)
	case "statfs":
		var s unix.Statfs_t
		if err := unix.Fstatfs(g.fd, &s); err != nil {
			return response{}, err
		}
		return response{Space: &space{Blocks: s.Blocks, Bfree: s.Bfree, Bavail: s.Bavail, Files: s.Files, Ffree: s.Ffree, Bsize: uint32(s.Bsize), Namelen: uint32(s.Namelen), Frsize: uint32(s.Frsize)}}, nil
	}
	d, err := g.get(r)
	if err != nil {
		return response{}, err
	}
	fd := int(d.file.Fd())
	switch r.Op {
	case "readdir":
		return g.directory(r, d)
	case "read":
		if r.Size == nil || *r.Size < 0 || *r.Size > maxChunk || r.Offset < 0 {
			return response{}, unix.EINVAL
		}
		b := make([]byte, int(*r.Size))
		n, e := unix.Pread(fd, b, r.Offset)
		if e != nil {
			return response{}, e
		}
		return response{Data: b[:n]}, nil
	case "write":
		if len(r.Data) > maxChunk || r.Offset < 0 {
			return response{}, unix.EINVAL
		}
		n, e := unix.Pwrite(fd, r.Data, r.Offset)
		return response{Written: n}, e
	case "flush":
		if !d.writable {
			return response{}, nil
		}
		return response{}, unix.Fsync(fd)
	case "fsync":
		return response{}, unix.Fsync(fd)
	case "release", "releasedir":
		delete(g.files, r.Handle)
		return response{}, d.file.Close()
	default:
		return response{}, unix.ENOSYS
	}
}

type envelope struct {
	ID      json.RawMessage `json:"id"`
	Request request         `json:"request"`
}

type reply struct {
	ID       json.RawMessage `json:"id"`
	Response response        `json:"response"`
}

func serve(g *guest, reader io.Reader, writer io.Writer) error {
	input := bufio.NewScanner(reader)
	input.Buffer(make([]byte, 4096), maxFrame)
	out := json.NewEncoder(writer)
	if e := out.Encode(map[string]any{"ready": true, "version": 1}); e != nil {
		return e
	}
	for input.Scan() {
		var message envelope
		if e := json.Unmarshal(input.Bytes(), &message); e != nil {
			return e
		}
		if len(message.ID) == 0 || len(message.ID) > 192 {
			return unix.EINVAL
		}
		res, err := g.execute(message.Request)
		if err != nil {
			res = failure(err)
		} else {
			res.OK = true
		}
		if e := out.Encode(reply{ID: message.ID, Response: res}); e != nil {
			return e
		}
	}
	return input.Err()
}
