/* SPDX-License-Identifier: MIT */
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
extern FILE *standard_popen(const char *, const char *) __asm("_popen");
extern FILE *unlimited_popen(const char *, const char *) __asm("_popen$DARWIN_EXTSN");

typedef struct PipeProcess {
    FILE *stream;
    int fd;
    pid_t pid;
    struct PipeProcess *next;
} PipeProcess;

static PipeProcess *pipes = NULL;
static pthread_mutex_t pipes_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t system_lock = PTHREAD_MUTEX_INITIALIZER;

static void execute_shell(const char *command) {
    char *const arguments[] = {"sh", "-c", (char *)command, NULL};
    execve("/bin/bash", arguments, environ);
    _exit(127);
}

static int wait_for(pid_t pid) {
    int status;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) return -1;
    }
    return status;
}

/* 保留管道与等待语义；不创建新会话或进程组，exec 仍受外层沙箱白名单约束。 */
static FILE *roc_popen(const char *command, const char *mode) {
    if (command == NULL || mode == NULL || (mode[0] != 'r' && mode[0] != 'w') || mode[1] != '\0') {
        errno = EINVAL;
        return NULL;
    }
    PipeProcess *entry = malloc(sizeof(*entry));
    if (entry == NULL) return NULL;
    int descriptors[2];
    if (pipe(descriptors) != 0) { free(entry); return NULL; }
    if (fcntl(descriptors[0], F_SETFD, FD_CLOEXEC) < 0 || fcntl(descriptors[1], F_SETFD, FD_CLOEXEC) < 0) {
        int error = errno;
        close(descriptors[0]); close(descriptors[1]); free(entry); errno = error;
        return NULL;
    }
    int parent_fd = descriptors[mode[0] == 'r' ? 0 : 1];
    int child_fd = descriptors[mode[0] == 'r' ? 1 : 0];
    int target_fd = mode[0] == 'r' ? STDOUT_FILENO : STDIN_FILENO;
    pthread_mutex_lock(&pipes_lock);
    pid_t pid = fork();
    if (pid == 0) {
        for (PipeProcess *other = pipes; other != NULL; other = other->next) close(other->fd);
        close(parent_fd);
        if (child_fd != target_fd) {
            if (dup2(child_fd, target_fd) < 0) _exit(127);
            close(child_fd);
        } else if (fcntl(child_fd, F_SETFD, 0) < 0) _exit(127);
        execute_shell(command);
    }
    int error = errno;
    close(child_fd);
    if (pid < 0) {
        pthread_mutex_unlock(&pipes_lock);
        close(parent_fd); free(entry); errno = error;
        return NULL;
    }
    FILE *stream = fdopen(parent_fd, mode);
    if (stream == NULL) {
        error = errno;
        pthread_mutex_unlock(&pipes_lock);
        close(parent_fd); kill(pid, SIGKILL); wait_for(pid); free(entry); errno = error;
        return NULL;
    }
    entry->stream = stream; entry->fd = parent_fd; entry->pid = pid;
    entry->next = pipes; pipes = entry;
    pthread_mutex_unlock(&pipes_lock);
    return stream;
}

static int roc_pclose(FILE *stream) {
    pthread_mutex_lock(&pipes_lock);
    PipeProcess **cursor = &pipes;
    while (*cursor != NULL && (*cursor)->stream != stream) cursor = &(*cursor)->next;
    PipeProcess *entry = *cursor;
    if (entry == NULL) { pthread_mutex_unlock(&pipes_lock); errno = EINVAL; return -1; }
    *cursor = entry->next;
    pthread_mutex_unlock(&pipes_lock);
    pid_t pid = entry->pid;
    free(entry);
    fclose(stream);
    return wait_for(pid);
}

static int roc_system(const char *command) {
    if (command == NULL) return access("/bin/bash", X_OK) == 0;
    pthread_mutex_lock(&system_lock);
    struct sigaction ignore = {0}, previous_int, previous_quit;
    ignore.sa_handler = SIG_IGN;
    sigemptyset(&ignore.sa_mask);
    sigaction(SIGINT, &ignore, &previous_int);
    sigaction(SIGQUIT, &ignore, &previous_quit);
    sigset_t blocked, previous_mask;
    sigemptyset(&blocked); sigaddset(&blocked, SIGCHLD);
    pthread_sigmask(SIG_BLOCK, &blocked, &previous_mask);
    pid_t pid = fork();
    if (pid == 0) {
        sigaction(SIGINT, &previous_int, NULL);
        sigaction(SIGQUIT, &previous_quit, NULL);
        sigprocmask(SIG_SETMASK, &previous_mask, NULL);
        execute_shell(command);
    }
    int status = pid < 0 ? -1 : wait_for(pid);
    int error = errno;
    sigaction(SIGINT, &previous_int, NULL);
    sigaction(SIGQUIT, &previous_quit, NULL);
    pthread_sigmask(SIG_SETMASK, &previous_mask, NULL);
    pthread_mutex_unlock(&system_lock);
    errno = error;
    return status;
}

__attribute__((used, section("__DATA,__interpose")))
static const struct { const void *replacement; const void *original; } replacements[] = {
    {(const void *)roc_popen, (const void *)standard_popen},
    {(const void *)roc_popen, (const void *)unlimited_popen},
    {(const void *)roc_pclose, (const void *)pclose},
    {(const void *)roc_system, (const void *)system}
};
