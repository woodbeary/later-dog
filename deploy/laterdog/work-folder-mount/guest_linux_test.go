package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func fixtureGuest(t *testing.T, directory string) *guest {
	t.Helper()
	g, err := newGuest(directory, "dog")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(g.close)
	return g
}
func invoke(t *testing.T, g *guest, r request) response {
	t.Helper()
	r.Root = "dog"
	out, e := g.execute(r)
	if e != nil {
		t.Fatalf("%s %q: %v", r.Op, r.Path, e)
	}
	return out
}
func TestScopedHandleAcrossRenameUnlinkAndRestart(t *testing.T) {
	directory := t.TempDir()
	g := fixtureGuest(t, directory)
	mode := uint32(0640)
	f := invoke(t, g, request{Op: "create", Path: "draft", Flags: unix.O_RDWR | unix.O_EXCL, Mode: &mode})
	invoke(t, g, request{Op: "write", Handle: f.Handle, Data: []byte("abc")})
	invoke(t, g, request{Op: "rename", Path: "draft", NewPath: "published"})
	info := invoke(t, g, request{Op: "getattr", Path: "published"})
	if info.Attr.Ino != f.Attr.Ino {
		t.Fatal("changed inode after rename")
	}
	invoke(t, g, request{Op: "link", Source: "published", Path: "link"})
	invoke(t, g, request{Op: "unlink", Path: "link"})
	invoke(t, g, request{Op: "unlink", Path: "published"})
	size := int64(2)
	mode = 0604
	changed := invoke(t, g, request{Op: "setattr", Handle: f.Handle, Mode: &mode, Size: &size})
	if changed.Attr.Nlink != 0 || changed.Attr.Mode&0777 != mode || changed.Attr.Size != size {
		t.Fatalf("%+v", changed.Attr)
	}
	out := invoke(t, g, request{Op: "read", Handle: f.Handle, Size: &size})
	if string(out.Data) != "ab" {
		t.Fatal(string(out.Data))
	}
	tooLarge := int64(maxChunk + 1)
	if _, err := g.execute(request{Root: "dog", Op: "read", Handle: f.Handle, Size: &tooLarge}); !errors.Is(err, unix.EINVAL) {
		t.Fatalf("oversize %v", err)
	}
	again := fixtureGuest(t, directory)
	copy := invoke(t, again, request{Op: "create", Path: "next", Mode: &mode, Flags: unix.O_RDWR})
	if copy.Handle == f.Handle {
		t.Fatal("stale descriptor can address a new helper")
	}
	if _, err := again.execute(request{Root: "dog", Op: "write", Handle: f.Handle, Data: []byte("late")}); !errors.Is(err, unix.EBADF) {
		t.Fatal(err)
	}
	invoke(t, g, request{Op: "release", Handle: f.Handle})
}
func TestCannotFollowEscapingNamesOrSymlinks(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "scope")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "secret"), []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("..", filepath.Join(dir, "outside")); err != nil {
		t.Fatal(err)
	}
	g := fixtureGuest(t, dir)
	for _, name := range []string{"/etc/passwd", "../secret", "outside/secret", "a//b", "./data"} {
		if _, err := g.execute(request{Op: "open", Root: "dog", Path: name}); err == nil {
			t.Fatal("opened", name)
		}
	}
	for _, r := range []request{{Op: "readlink", Path: "outside"}, {Op: "rename", Path: "outside/secret", NewPath: "copy"}, {Op: "unlink", Path: "outside/secret"}, {Op: "symlink", Path: "s", Target: "../secret"}} {
		r.Root = "dog"
		if _, err := g.execute(r); err == nil {
			t.Fatal(r.Op)
		}
	}
	if got := invoke(t, g, request{Op: "readlinkMetadata", Path: "outside"}); got.Target != ".." || got.Projected {
		t.Fatal(got)
	}
	if _, err := g.execute(request{Op: "readlinkMetadata", Root: "dog", Path: "outside/secret"}); err == nil {
		t.Fatal("opened parent outside the assigned root")
	}
	if out, err := os.ReadFile(filepath.Join(base, "secret")); err != nil || string(out) != "outside" {
		t.Fatal(err)
	}
	mode := uint32(0700)
	invoke(t, g, request{Op: "mkdir", Path: "sub", Mode: &mode})
	invoke(t, g, request{Op: "symlink", Path: "sub/valid", Target: "../sibling"})
	if got := invoke(t, g, request{Op: "readlink", Path: "sub/valid"}).Target; got != "../sibling" {
		t.Fatal(got)
	}
}
func TestDirectoryPagesAndScopedStdio(t *testing.T) {
	base := t.TempDir()
	g := fixtureGuest(t, base)
	for i := 0; i < 72; i++ {
		if err := os.WriteFile(filepath.Join(base, strconv.Itoa(i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	dir := invoke(t, g, request{Op: "opendir"})
	first := invoke(t, g, request{Op: "readdir", Handle: dir.Handle})
	if len(first.Entries) != 64 || first.Next != "64" {
		t.Fatalf("first page %d %q", len(first.Entries), first.Next)
	}
	last := invoke(t, g, request{Op: "readdir", Handle: dir.Handle, Cursor: first.Next})
	if len(last.Entries) != 8 || last.Next != "" {
		t.Fatalf("last page %d %q", len(last.Entries), last.Next)
	}
	rewind := invoke(t, g, request{Op: "readdir", Handle: dir.Handle, Cursor: "0"})
	if rewind.Entries[0] != first.Entries[0] {
		t.Fatal("directory rewind")
	}
	var out bytes.Buffer
	payload := "{\"id\":\"hello\",\"request\":{\"op\":\"getattr\",\"root\":\"dog\",\"path\":\"\"}}\n{\"id\":42,\"request\":{\"op\":\"getattr\",\"root\":\"other\",\"path\":\"\"}}\n"
	if err := serve(g, bytes.NewBufferString(payload), &out); err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(&out)
	var ready struct {
		Ready   bool
		Version int
	}
	var one, two reply
	if e := dec.Decode(&ready); e != nil || !ready.Ready || ready.Version != 1 {
		t.Fatal(ready, e)
	}
	if e := dec.Decode(&one); e != nil || string(one.ID) != "\"hello\"" || !one.Response.OK || one.Response.Attr == nil {
		t.Fatal(one, e)
	}
	if e := dec.Decode(&two); e != nil || string(two.ID) != "42" || two.Response.Errno != "EACCES" {
		t.Fatal(two, e)
	}
	if e := dec.Decode(&one); e != io.EOF {
		t.Fatal(e)
	}
}

func TestAllowOnlyCanonicalProjectedProjectNames(t *testing.T) {
	root := "/run/laterdog-work-folders/tree/project-" + strings.Repeat("a", 64)
	for _, name := range []string{root, root + "/sub/ok"} {
		if !projectedTarget(name) {
			t.Fatal(name)
		}
	}
	for _, name := range []string{root + "/", root + "/../bad", root + "/./bad", root + "//bad", root + "/bad/../leaf", root + "F/sub", root[0:len(root)-1] + "bX", "/etc/shadow", "../../target"} {
		if projectedTarget(name) {
			t.Fatal(name)
		}
	}
}
