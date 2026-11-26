package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type adapter struct {
	root   string
	client *http.Client
	limit  chan struct{}
}

func newAdapter(socket, root string) *adapter {
	transport := &http.Transport{MaxConnsPerHost: 32, MaxIdleConnsPerHost: 32, IdleConnTimeout: time.Minute,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		}}
	return &adapter{root: root, client: &http.Client{Transport: transport, Timeout: 6 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, limit: make(chan struct{}, 32)}
}

func (a *adapter) call(ctx context.Context, v request) (response, syscall.Errno) {
	select {
	case a.limit <- struct{}{}:
		defer func() { <-a.limit }()
	case <-ctx.Done():
		return response{}, unix.EINTR
	}
	v.Root = a.root
	data, err := json.Marshal(v)
	if err != nil || len(data) > maxFrame {
		return response{}, unix.EINVAL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://local/v1/fs", bytes.NewReader(data))
	if err != nil {
		return response{}, unix.EIO
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := a.client.Do(req)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return response{}, unix.EINTR
		}
		return response{}, unix.EIO
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return response{}, unix.EIO
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxFrame+1))
	if err != nil || len(body) > maxFrame {
		return response{}, unix.EIO
	}
	var result response
	if err := json.Unmarshal(body, &result); err != nil {
		return response{}, unix.EIO
	}
	return result, result.status()
}

type remoteFile struct {
	api    *adapter
	key    string
	folder string
}

func (f *remoteFile) call(ctx context.Context, r request) (response, syscall.Errno) {
	r.Handle = f.key
	r.Path = f.folder
	return f.api.call(ctx, r)
}

type remoteDir struct {
	remoteFile
	mu       sync.Mutex
	position uint64
	page     []entry
	end      bool
}
