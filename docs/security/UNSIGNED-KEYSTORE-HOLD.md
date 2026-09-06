# Unsigned build file keystore (design hold)

macOS unsigned / `ASKTOTO_LOCAL_KEYSTORE=1` keeps the AES file key beside its ciphertexts
(`src/main/index.ts` / `secrets.ts`). Documented tradeoff for unsigned builds; goes away with signed +
notarized builds. **Held** on this residual lane — no code change here.
