#include <sys/event.h>
#include <sys/wait.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <limits.h>

/* This trusted supervisor stays outside the computation's Seatbelt and process
 * group. Register the actual spawning host before releasing any computation.
 * A host SIGKILL is a kernel event; no application cleanup callback is needed. */
static int watch_exit(int queue, pid_t pid) {
  struct kevent change;
  EV_SET(&change, (uintptr_t)pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT, NOTE_EXIT, 0, NULL);
  return kevent(queue, &change, 1, NULL, 0, NULL);
}

static int fail(const char *phase) {
  fprintf(stderr, "research_process_guard_%s:%d\n", phase, errno);
  return 125;
}

static int kill_group(pid_t pid) {
  for (int attempt = 0; attempt < 100; attempt++) {
    if (kill(-pid, SIGKILL) < 0 && errno != ESRCH && errno != EPERM) return -1;
    if (kill(-pid, 0) < 0 && errno == ESRCH) return 0;
    usleep(10000);
  }
  return -1;
}

int main(int argc, char **argv) {
  if (argc < 4) return 125;
  char *end = NULL;
  long parent_value = strtol(argv[1], &end, 10);
  if (end == argv[1] || *end != '\0' || parent_value < 2 || parent_value > INT_MAX) return 125;
  pid_t parent = (pid_t)parent_value;
  int queue = kqueue();
  if (queue < 0 || getppid() != parent || watch_exit(queue, parent) < 0 || getppid() != parent) return fail("host_watch_failed");

  int gate[2];
  if (pipe(gate) < 0) return fail("gate_failed");
  pid_t computation = fork();
  if (computation < 0) return fail("fork_failed");
  if (computation == 0) {
    close(queue);
    close(3);
    close(gate[1]);
    if (setpgid(0, 0) < 0) _exit(125);
    char start;
    if (read(gate[0], &start, 1) != 1) _exit(125);
    close(gate[0]);
    execv(argv[2], &argv[2]);
    _exit(126);
  }
  close(gate[0]);
  close(STDIN_FILENO);
  /* Both sides establish the same group before the gated exec. */
  if (setpgid(computation, computation) < 0 || watch_exit(queue, computation) < 0) {
    close(gate[1]);
    kill(computation, SIGKILL);
    waitpid(computation, NULL, 0);
    return fail("computation_watch_failed");
  }
  if (dprintf(3, "%d\n", computation) < 0 || write(gate[1], "1", 1) != 1) {
    close(gate[1]);
    kill(computation, SIGKILL);
    waitpid(computation, NULL, 0);
    return fail("start_failed");
  }
  close(gate[1]);

  struct kevent event;
  int received;
  do { received = kevent(queue, NULL, 0, &event, 1, NULL); } while (received < 0 && errno == EINTR);
  int host_exited = received != 1 || (event.flags & EV_ERROR) != 0 || event.ident == (uintptr_t)parent;
  if (kill(-computation, SIGKILL) < 0 && errno != ESRCH && errno != EPERM) return fail("signal_failed");
  int status;
  pid_t reaped;
  do { reaped = waitpid(computation, &status, 0); } while (reaped < 0 && errno == EINTR);
  if (kill_group(computation) < 0) return fail("cleanup_failed");
  close(queue);
  if (host_exited || reaped != computation) return fail("host_or_watch_exited");
  if (WIFEXITED(status)) {
    if (dprintf(3, "exit %d\n", WEXITSTATUS(status)) < 0) return 125;
    return 0;
  }
  if (WIFSIGNALED(status)) {
    if (dprintf(3, "exit %d\n", 128 + WTERMSIG(status)) < 0) return 125;
    return 0;
  }
  return 125;
}
