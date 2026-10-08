/* Hosted-only compiled controls for the exact fixture classifier; no Keychain API calls. */
#define main hosted_api_fixture_main
#include "security-broker-api.fixture.c"
#undef main

_Static_assert(errSecNoDefaultKeychain == -25307, "unexpected no-default-keychain status");

int main(void) {
    const char *hosted = getenv("RUNNER_ENVIRONMENT");
    const char *actions = getenv("GITHUB_ACTIONS");
    if (!hosted || strcmp(hosted, "github-hosted") ||
        !actions || strcmp(actions, "true")) return fail_stage("classifier-hosted-admission");

    const struct {
        OSStatus status;
        bool has_reference;
        enum default_metadata_state expected;
    } cases[] = {
        {errSecSuccess, true, DEFAULT_METADATA_PRESENT},
        {errSecNoDefaultKeychain, false, DEFAULT_METADATA_NOT_CONFIGURED},
        {errSecSuccess, false, DEFAULT_METADATA_ERROR},
        {errSecNoDefaultKeychain, true, DEFAULT_METADATA_ERROR},
        {errSecAuthFailed, false, DEFAULT_METADATA_ERROR},
        {errSecAuthFailed, true, DEFAULT_METADATA_ERROR},
        {errSecItemNotFound, false, DEFAULT_METADATA_ERROR},
        {errSecItemNotFound, true, DEFAULT_METADATA_ERROR},
        {errSecNotAvailable, false, DEFAULT_METADATA_ERROR},
        {errSecNotAvailable, true, DEFAULT_METADATA_ERROR},
        {-1, false, DEFAULT_METADATA_ERROR},
        {-1, true, DEFAULT_METADATA_ERROR},
        {1, false, DEFAULT_METADATA_ERROR},
        {1, true, DEFAULT_METADATA_ERROR}
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        enum default_metadata_state actual = classify_default_metadata(cases[i].status, cases[i].has_reference);
        if (actual != cases[i].expected) {
            fprintf(stderr, "HOSTED_METADATA_CLASSIFIER case %zu status %d reference %d expected %d actual %d\n",
                    i, (int)cases[i].status, cases[i].has_reference, (int)cases[i].expected, (int)actual);
            return 1;
        }
    }
    if (puts("PASS: hosted metadata classifier 14 cases") == EOF || fflush(stdout) != 0) return 2;
    return 0;
}
