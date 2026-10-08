/* No Security framework or keychain query: observe only launchd lookup denial. */
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

_Static_assert(BOOTSTRAP_NOT_PRIVILEGED == 1100, "unexpected bootstrap denial status");

static const char *const services[] = {
    "com.apple.SecurityServer",
    "com.apple.securityd",
    "com.apple.securityd.xpc",
    "com.apple.securityd.systemkeychain",
    "com.apple.securityd.aps",
    "com.apple.securityd.ckks",
    "com.apple.securityd.general",
    "com.apple.securityd.sos",
    "com.apple.security.octagon",
    "com.apple.security.escrow-update",
    "com.apple.security.kcsharing",
};

static void expired(int signal_number) {
    (void)signal_number;
    _exit(124);
}

int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1 || signal(SIGALRM, expired) == SIG_ERR) return 2;
    alarm(10);
    int failed = 0;
    for (size_t i = 0; i < sizeof(services) / sizeof(services[0]); i++) {
        mach_port_t port = MACH_PORT_NULL;
        kern_return_t status = bootstrap_look_up(bootstrap_port, services[i], &port);
        int unexpected_port = port != MACH_PORT_NULL;
        if (status != BOOTSTRAP_NOT_PRIVILEGED || unexpected_port) failed = 1;
        if (unexpected_port) {
            kern_return_t cleanup = mach_port_deallocate(mach_task_self(), port);
            if (cleanup != KERN_SUCCESS) {
                fprintf(stderr, "broker port release failed: %d\n", cleanup);
                failed = 1;
            }
        }
        /* Service identifiers are fixed public names; never print a returned port. */
        if (printf("%s %d %d\n", services[i], status, unexpected_port) < 0) return 2;
    }
    alarm(0);
    if (failed) return 1;
    if (puts("BROKER_LOOKUP_DENIED") == EOF || fflush(stdout) != 0) return 2;
    return 0;
}
