package main

import (
	"errors"
	"path"
	"strings"
	"syscall"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

const maxChunk = 128 << 10
const maxFrame = 256 << 10
const pageSize = 64

type request struct {
	Op      string  `json:"op"`
	Root    string  `json:"root"`
	Path    string  `json:"path"`
	NewPath string  `json:"newPath,omitempty"`
	Target  string  `json:"target,omitempty"`
	Source  string  `json:"source,omitempty"`
	Handle  string  `json:"handle,omitempty"`
	Cursor  string  `json:"cursor,omitempty"`
	Flags   uint32  `json:"flags,omitempty"`
	Offset  int64   `json:"offset,string,omitempty"`
	Size    *int64  `json:"size,string,omitempty"`
	Mode    *uint32 `json:"mode,omitempty"`
	UID     *uint32 `json:"uid,omitempty"`
	GID     *uint32 `json:"gid,omitempty"`
	Atime   *int64  `json:"atimeNs,string,omitempty"`
	Mtime   *int64  `json:"mtimeNs,string,omitempty"`
	Data    []byte  `json:"data,omitempty"`
}

type attr struct {
	Ino    uint64 `json:"ino,string"`
	Mode   uint32 `json:"mode"`
	Size   int64  `json:"size,string"`
	Atime  int64  `json:"atimeNs,string"`
	Mtime  int64  `json:"mtimeNs,string"`
	Ctime  int64  `json:"ctimeNs,string"`
	Nlink  uint64 `json:"nlink"`
	UID    uint32 `json:"uid"`
	GID    uint32 `json:"gid"`
	Blocks int64  `json:"blocks,string"`
}

type entry struct {
	Name string `json:"name"`
	Ino  uint64 `json:"ino,string"`
	Mode uint32 `json:"mode"`
}

type space struct {
	Blocks  uint64 `json:"blocks,string"`
	Bfree   uint64 `json:"bfree,string"`
	Bavail  uint64 `json:"bavail,string"`
	Files   uint64 `json:"files,string"`
	Ffree   uint64 `json:"ffree,string"`
	Bsize   uint32 `json:"bsize"`
	Namelen uint32 `json:"namelen"`
	Frsize  uint32 `json:"frsize"`
}

type response struct {
	OK      bool    `json:"ok"`
	Errno   string  `json:"errno,omitempty"`
	Attr    *attr   `json:"attr,omitempty"`
	Handle  string  `json:"handle,omitempty"`
	Target  string  `json:"target,omitempty"`
	Data    []byte  `json:"data,omitempty"`
	Written int     `json:"written,omitempty"`
	Entries []entry `json:"entries,omitempty"`
	Next    string  `json:"next,omitempty"`
	Space   *space  `json:"space,omitempty"`
}

func component(name string) bool {
	return name != "" && name != "." && name != ".." && utf8.ValidString(name) &&
		!strings.ContainsAny(name, "/\x00") && len(name) <= 255
}

func validPath(name string) bool {
	if len(name) > 4095 {
		return false
	}
	if name == "" {
		return true
	}
	for _, part := range strings.Split(name, "/") {
		if !component(part) {
			return false
		}
	}
	return true
}

func safeTarget(name, target string) bool {
	if target == "" || path.IsAbs(target) || len(target) > 4095 || !utf8.ValidString(target) || strings.ContainsRune(target, 0) {
		return false
	}
	end := path.Join(path.Dir(name), target)
	return end != ".." && !strings.HasPrefix(end, "../")
}

var errnoByName = func() map[string]syscall.Errno {
	names := make(map[string]syscall.Errno)
	for code := syscall.Errno(1); code < 256; code++ {
		if name := unix.ErrnoName(code); name != "" {
			names[name] = code
		}
	}
	return names
}()

func failure(err error) response {
	var code syscall.Errno
	if !errors.As(err, &code) || unix.ErrnoName(code) == "" {
		code = unix.EIO
	}
	return response{Errno: unix.ErrnoName(code)}
}

func (r response) status() syscall.Errno {
	if r.OK && r.Errno == "" {
		return 0
	}
	if code, ok := errnoByName[r.Errno]; ok {
		return code
	}
	return unix.EIO
}
