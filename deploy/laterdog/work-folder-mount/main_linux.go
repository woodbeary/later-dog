package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

func run() error {
	stdio := flag.Bool("stdio", false, "serve a scoped folder on standard input and output")
	dir := flag.String("directory", "", "existing guest folder")
	socket := flag.String("socket", "", "absolute path to the local adapter socket")
	root := flag.String("root", "", "folder identifier")
	point := flag.String("mount", "", "empty home mountpoint")
	other := flag.Bool("allow-other", false, "allow other local users subject to file permissions")
	flag.Parse()
	if *stdio && *dir != "" && *socket == "" && *point == "" {
		syscall.Umask(0)
		g, err := newGuest(*dir, *root)
		if err != nil {
			return err
		}
		defer g.close()
		return serve(g, os.Stdin, os.Stdout)
	}
	if *stdio || *dir != "" || !filepath.IsAbs(*socket) || !filepath.IsAbs(*point) || *root == "" {
		return errors.New("specify --stdio --directory or --socket --root --mount")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server, err := mount(ctx, *point, newAdapter(*socket, *root), *other)
	if err != nil {
		return err
	}
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"ready": true, "version": 1}); err != nil {
		server.Unmount()
		return err
	}
	go func() { <-ctx.Done(); server.Unmount() }()
	server.Wait()
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
