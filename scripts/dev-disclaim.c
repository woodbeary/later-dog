// Starts a program as its own macOS "responsible process", so privacy prompts
// (microphone, camera) belong to later.dog Dev instead of the node launcher.
// node is built with the hardened runtime and no audio-input entitlement, so
// macOS silently refuses the microphone to anything node is responsible for.
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

static volatile pid_t child = 0;

static void forward(int signal) {
  if (child > 0) kill(child, signal);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s program [args...]\n", argv[0]);
    return 64;
  }
  posix_spawnattr_t attributes;
  posix_spawnattr_init(&attributes);
  responsibility_spawnattrs_setdisclaim(&attributes, 1);
  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = forward;
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGHUP, &action, NULL);
  pid_t pid;
  int error = posix_spawn(&pid, argv[1], NULL, &attributes, argv + 1, environ);
  posix_spawnattr_destroy(&attributes);
  if (error) {
    fprintf(stderr, "%s: %s\n", argv[1], strerror(error));
    return 127;
  }
  child = pid;
  int status;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return 1;
  }
  if (WIFSIGNALED(status)) {
    signal(WTERMSIG(status), SIG_DFL);
    kill(getpid(), WTERMSIG(status));
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
