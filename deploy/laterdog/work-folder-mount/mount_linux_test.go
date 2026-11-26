package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

func TestActualKernelMount(t *testing.T) {
	if os.Getenv("LATERDOG_TEST_KERNEL_FUSE") != "1" {
		t.Skip("set LATERDOG_TEST_KERNEL_FUSE=1 on a FUSE-capable Linux host")
	}
	dir := t.TempDir()
	backing := filepath.Join(dir, "guest")
	point := filepath.Join(dir, "home")
	for _, d := range []string{backing, point} {
		if e := os.Mkdir(d, 0700); e != nil {
			t.Fatal(e)
		}
	}
	g := fixtureGuest(t, backing)
	var mu sync.Mutex
	service := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/fs" {
			http.NotFound(w, r)
			return
		}
		var req request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid command", 400)
			return
		}
		mu.Lock()
		res, err := g.execute(req)
		mu.Unlock()
		if err != nil {
			res = failure(err)
		} else {
			res.OK = true
		}
		json.NewEncoder(w).Encode(res)
	})}
	socket := filepath.Join(dir, "s")
	listener, e := net.Listen("unix", socket)
	if e != nil {
		t.Fatal(e)
	}
	go service.Serve(listener)
	defer service.Close()
	server, e := mount(context.Background(), point, newAdapter(socket, "dog"), false)
	if e != nil {
		t.Fatal(e)
	}
	defer server.Unmount()
	file := filepath.Join(point, "old")
	next := filepath.Join(point, "new")
	f, e := os.OpenFile(file, os.O_CREATE|os.O_RDWR, 0640)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	if _, e = f.Write([]byte("initial")); e != nil {
		t.Fatal(e)
	}
	if e = f.Sync(); e != nil {
		t.Fatal(e)
	}
	if e = os.Rename(file, next); e != nil {
		t.Fatal(e)
	}
	if e = os.Chmod(next, 0601); e != nil {
		t.Fatal(e)
	}
	target := filepath.Join(point, "dir")
	if e = os.Mkdir(target, 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.Symlink("../new", filepath.Join(target, "s")); e != nil {
		t.Fatal(e)
	}
	if text, e := os.ReadFile(filepath.Join(target, "s")); e != nil || string(text) != "initial" {
		t.Fatal(string(text), e)
	}
	if e = os.Link(next, filepath.Join(point, "hard")); e != nil {
		t.Fatal(e)
	}
	if e = os.Truncate(next, 3); e != nil {
		t.Fatal(e)
	}
	if e = os.Remove(next); e != nil {
		t.Fatal(e)
	}
	if e = os.Remove(filepath.Join(point, "hard")); e != nil {
		t.Fatal(e)
	}
	buf := make([]byte, 3)
	if _, e = f.ReadAt(buf, 0); e != nil || string(buf) != "ini" {
		t.Fatal(string(buf), e)
	}
	if e = f.Close(); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(backing, "external"), []byte("guest"), 0644); e != nil {
		t.Fatal(e)
	}
	if text, e := os.ReadFile(filepath.Join(point, "external")); e != nil || string(text) != "guest" {
		t.Fatal(string(text), e)
	}
	entries, e := os.ReadDir(point)
	if e != nil || len(entries) != 2 {
		t.Fatal(entries, e)
	}
	if e = os.Remove(filepath.Join(target, "s")); e != nil {
		t.Fatal(e)
	}
	if e = os.Remove(target); e != nil {
		t.Fatal(e)
	}
	d, e := os.Open(point)
	if e != nil {
		t.Fatal(e)
	}
	if e = d.Sync(); e != nil {
		t.Fatal(e)
	}
	d.Close()
	service.Close()
	if _, e := os.ReadFile(filepath.Join(point, "external")); e == nil || !errors.Is(e, syscall.EIO) {
		t.Fatalf("failure did not close access %v", e)
	}
	if e = server.Unmount(); e != nil {
		t.Fatal(e)
	}
	if files, e := os.ReadDir(point); e != nil || len(files) > 0 {
		t.Fatalf("local bytes beneath mount %v %v", files, e)
	}
	if _, e = os.Stat(filepath.Join(backing, "external")); errors.Is(e, unix.ENOENT) {
		t.Fatal(e)
	}
}
