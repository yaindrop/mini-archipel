#include <stdlib.h>
#include <sys/wait.h>

/* A real process ancestry probe; it executes hooks without starting Actions CI. */
int main(void) {
    unsetenv("GITHUB_WORKSPACE");
    int status = system("/bin/bash \"$HOME/.local/libexec/mini-ci/job-started.sh\" && "
                        "/bin/bash \"$HOME/.local/libexec/mini-ci/job-completed.sh\"");
    return status == -1 || !WIFEXITED(status) ? 1 : WEXITSTATUS(status);
}
