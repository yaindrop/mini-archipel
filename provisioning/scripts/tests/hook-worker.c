#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

/* A real process ancestry probe; it executes hooks without starting Actions CI. */
int main(void) {
    unsetenv("GITHUB_WORKSPACE");
    int status = system("/bin/bash \"$HOME/.local/libexec/mini-archipel/ci/job-started.sh\"");
    if (status != 0) return 1;
    const char *ready = getenv("MINI_CI_FIXTURE_READY");
    const char *release = getenv("MINI_CI_FIXTURE_RELEASE");
    if (ready && release) {
        FILE *file = fopen(ready, "w");
        if (!file) return 1;
        fclose(file);
        unsigned int ticks = 0;
        while (access(release, F_OK) != 0) {
            if (++ticks > 3000) return 1;
            usleep(10000);
        }
        unlink(ready);
    }
    status = system("/bin/bash \"$HOME/.local/libexec/mini-archipel/ci/job-completed.sh\"");
    return status == -1 || !WIFEXITED(status) ? 1 : WEXITSTATUS(status);
}
