/* Hosted-only API control. Not linked into, or invoked by, the production lookup probe. */
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void expired(int signal_number) {
    (void)signal_number;
    _exit(124);
}

static int fail_stage(const char *stage) {
    fprintf(stderr, "HOSTED_API_STAGE %s failed\n", stage);
    return 2;
}

static int fail_status(const char *stage, OSStatus status) {
    fprintf(stderr, "HOSTED_API_STAGE %s status %d\n", stage, (int)status);
    return 2;
}

enum default_metadata_state {
    DEFAULT_METADATA_ERROR,
    DEFAULT_METADATA_PRESENT,
    DEFAULT_METADATA_NOT_CONFIGURED
};

static enum default_metadata_state classify_default_metadata(OSStatus status, bool has_reference) {
    if (status == errSecSuccess && has_reference) return DEFAULT_METADATA_PRESENT;
    if (status == errSecNoDefaultKeychain && !has_reference) return DEFAULT_METADATA_NOT_CONFIGURED;
    return DEFAULT_METADATA_ERROR;
}

static int metadata(void) {
    CFArrayRef search = NULL;
    SecKeychainRef current = NULL;
    OSStatus status = SecKeychainCopySearchList(&search);
    if (status != errSecSuccess) return fail_status("metadata-search-list", status);
    if (!search) return fail_stage("metadata-search-list-null");
    status = SecKeychainCopyDefault(&current);
    enum default_metadata_state state = classify_default_metadata(status, current != NULL);
    if (state == DEFAULT_METADATA_ERROR) {
        if (current) CFRelease(current);
        CFRelease(search);
        return fail_status("metadata-default", status);
    }
    if (state == DEFAULT_METADATA_NOT_CONFIGURED &&
        printf("-1:DEFAULT_NOT_CONFIGURED:%d\n", (int)status) < 0) {
        CFRelease(search);
        return fail_stage("metadata-output");
    }
    CFIndex count = CFArrayGetCount(search);
    for (CFIndex i = state == DEFAULT_METADATA_PRESENT ? -1 : 0; i < count; i++) {
        SecKeychainRef keychain = i == -1 ? current : (SecKeychainRef)CFArrayGetValueAtIndex(search, i);
        char path[4096];
        UInt32 length = sizeof(path);
        if (!keychain) return fail_stage("metadata-entry-null");
        status = SecKeychainGetPath(keychain, &length, path);
        if (status != errSecSuccess) return fail_status("metadata-path", status);
        if (length >= sizeof(path)) return fail_stage("metadata-path-length");
        path[length] = '\0';
        if (printf("%ld:%s\n", (long)i, path) < 0) return fail_stage("metadata-output");
    }
    if (current) CFRelease(current);
    CFRelease(search);
    return fflush(stdout) == 0 ? 0 : fail_stage("metadata-flush");
}

int main(int argc, char **argv) {
    const char *hosted = getenv("RUNNER_ENVIRONMENT");
    const char *actions = getenv("GITHUB_ACTIONS");
    if (argc != 2 || !hosted || strcmp(hosted, "github-hosted") ||
        !actions || strcmp(actions, "true")) return fail_stage("hosted-admission");
    if (signal(SIGALRM, expired) == SIG_ERR) return fail_stage("alarm-handler");
    alarm(10);
    OSStatus status = SecKeychainSetUserInteractionAllowed(false);
    if (status != errSecSuccess) return fail_status("disable-interaction", status);
    if (strcmp(argv[1], "--metadata") == 0) return metadata();
    if (argv[1][0] != '/') return fail_stage("fixture-path");
    SecKeychainRef keychain = NULL;
    const char password[] = "synthetic-private-fixture-only";
    status = SecKeychainCreate(argv[1], (UInt32)strlen(password), password, false, NULL, &keychain);
    const char *stage = "create";
    if (status == errSecSuccess && keychain) {
        const void *keys[] = {kSecClass, kSecAttrService, kSecAttrAccount, kSecValueData, kSecUseKeychain};
        const UInt8 bytes[] = "synthetic";
        CFDataRef data = CFDataCreate(NULL, bytes, sizeof(bytes) - 1);
        if (!data) return fail_stage("value-allocation");
        const void *values[] = {kSecClassGenericPassword, CFSTR("metis-hosted-broker-proof"),
                               CFSTR("synthetic"), data, keychain};
        CFDictionaryRef item = CFDictionaryCreate(NULL, keys, values, 5,
                                                  &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        if (!item) return fail_stage("item-allocation");
        status = SecItemAdd(item, NULL);
        stage = "add";
        CFRelease(item);
        CFRelease(data);
    }
    if (keychain) CFRelease(keychain);
    alarm(0);
    if (printf("SYNTHETIC_API %s %d\n", stage, (int)status) < 0 || fflush(stdout) != 0) {
        return fail_stage("api-output");
    }
    return status == errSecSuccess ? 0 : 3;
}
