/* Hosted-only API control. Not linked into, or invoked by, the production lookup probe. */
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void expired(int signal_number) {
    (void)signal_number;
    _exit(124);
}

static int metadata(void) {
    CFArrayRef search = NULL;
    SecKeychainRef current = NULL;
    if (SecKeychainCopySearchList(&search) != errSecSuccess || !search ||
        SecKeychainCopyDefault(&current) != errSecSuccess || !current) return 2;
    CFIndex count = CFArrayGetCount(search);
    for (CFIndex i = -1; i < count; i++) {
        SecKeychainRef keychain = i == -1 ? current : (SecKeychainRef)CFArrayGetValueAtIndex(search, i);
        char path[4096];
        UInt32 length = sizeof(path);
        if (!keychain || SecKeychainGetPath(keychain, &length, path) != errSecSuccess ||
            length >= sizeof(path)) return 2;
        path[length] = '\0';
        printf("%ld:%s\n", (long)i, path);
    }
    CFRelease(current);
    CFRelease(search);
    return fflush(stdout) == 0 ? 0 : 2;
}

int main(int argc, char **argv) {
    const char *hosted = getenv("RUNNER_ENVIRONMENT");
    const char *actions = getenv("GITHUB_ACTIONS");
    if (argc != 2 || !hosted || strcmp(hosted, "github-hosted") ||
        !actions || strcmp(actions, "true") || signal(SIGALRM, expired) == SIG_ERR) return 2;
    alarm(10);
    OSStatus status = SecKeychainSetUserInteractionAllowed(false);
    if (status != errSecSuccess) return 2;
    if (strcmp(argv[1], "--metadata") == 0) return metadata();
    if (argv[1][0] != '/') return 2;
    SecKeychainRef keychain = NULL;
    const char password[] = "synthetic-private-fixture-only";
    status = SecKeychainCreate(argv[1], (UInt32)strlen(password), password, false, NULL, &keychain);
    const char *stage = "create";
    if (status == errSecSuccess && keychain) {
        const void *keys[] = {kSecClass, kSecAttrService, kSecAttrAccount, kSecValueData, kSecUseKeychain};
        const UInt8 bytes[] = "synthetic";
        CFDataRef data = CFDataCreate(NULL, bytes, sizeof(bytes) - 1);
        if (!data) return 2;
        const void *values[] = {kSecClassGenericPassword, CFSTR("metis-hosted-broker-proof"),
                               CFSTR("synthetic"), data, keychain};
        CFDictionaryRef item = CFDictionaryCreate(NULL, keys, values, 5,
                                                  &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        if (!item) return 2;
        status = SecItemAdd(item, NULL);
        stage = "add";
        CFRelease(item);
        CFRelease(data);
    }
    if (keychain) CFRelease(keychain);
    alarm(0);
    printf("SYNTHETIC_API %s %d\n", stage, (int)status);
    return status == errSecSuccess ? 0 : 3;
}
