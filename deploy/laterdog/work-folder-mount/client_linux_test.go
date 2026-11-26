package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestStalledServiceFailsMetadataQuickly(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "mount.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	stalled := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-stalled })}
	go server.Serve(listener)
	defer func() { close(stalled); server.Close(); os.Remove(socket) }()
	a := newAdapter(socket, "dog")
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, code := a.call(ctx, request{Op: "getattr"}); code != unix.ETIMEDOUT {
		t.Fatalf("stalled call returned %v, want ETIMEDOUT", code)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatalf("stalled call took %v", time.Since(started))
	}
}

func TestCallTimeouts(t *testing.T) {
	if callTimeout("getattr") != metadataCallTimeout || callTimeout("lookup") != metadataCallTimeout {
		t.Fatal("metadata calls must use the short timeout")
	}
	if callTimeout("read") != dataCallTimeout || callTimeout("write") != dataCallTimeout {
		t.Fatal("data calls must use the data timeout")
	}
	if metadataCallTimeout > 30*time.Second || dataCallTimeout > 2*time.Minute {
		t.Fatal("a stalled computer must not hold a call for minutes")
	}
	if stoppedCall(context.DeadlineExceeded) != unix.ETIMEDOUT || stoppedCall(context.Canceled) != unix.EINTR || stoppedCall(errors.New("x")) != unix.EIO {
		t.Fatal("stopped calls map to the wrong errno")
	}
}
