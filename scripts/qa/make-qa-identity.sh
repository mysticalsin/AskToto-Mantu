#!/usr/bin/env bash
# Creates the stable QA code-signing identity for the QA candidate lane and stores it as this
# repository's QA_MAC_SIGNING secret (M2-0187, owner step B-05). The program owner runs it once, on macOS,
# in an account where `gh` is signed in.
#
# The identity is a self-signed code-signing certificate valid for ten years. Candidates signed with it
# keep one designated requirement across builds, so a TCC grant given to one candidate carries over to
# the next. It is not a Developer ID and cannot notarize.
#
# The private key exists only in a temporary directory, deleted on exit, and in the secret. Replacing the
# identity resets every TCC grant made to earlier candidates, so replacing needs --replace.
#
#   scripts/qa/make-qa-identity.sh [--replace]
set -euo pipefail

readonly REPO=mysticalsin/AskToto-Mantu
readonly SECRET=QA_MAC_SIGNING
readonly NAME='Metis QA Code Signing'
# macOS LibreSSL. Its PKCS#12 output with these algorithms imports with `security import`.
readonly OPENSSL=/usr/bin/openssl

replace=false
case "${1:-}" in
  '') ;;
  --replace) replace=true ;;
  *) echo "usage: $0 [--replace]" >&2; exit 2 ;;
esac

if ! $replace && gh secret list --repo "$REPO" --json name --jq '.[].name' | grep -Fxq "$SECRET"; then
  echo "$SECRET already exists. Replacing it resets TCC grants for every earlier candidate; rerun with --replace to do that." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/request.cnf" <<EOF
[req]
distinguished_name = subject
x509_extensions = code_signing
prompt = no
[subject]
CN = $NAME
[code_signing]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF
"$OPENSSL" req -x509 -newkey rsa:3072 -nodes -days 3650 -config "$work/request.cnf" \
  -keyout "$work/key.pem" -out "$work/certificate.pem"
P12_PASSWORD=$("$OPENSSL" rand -hex 32)
export P12_PASSWORD
"$OPENSSL" pkcs12 -export -name "$NAME" -inkey "$work/key.pem" -in "$work/certificate.pem" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -passout env:P12_PASSWORD -out "$work/identity.p12"
printf '{"p12_base64":"%s","password":"%s"}' "$(base64 < "$work/identity.p12" | tr -d '\n')" "$P12_PASSWORD" \
  | gh secret set "$SECRET" --repo "$REPO"
fingerprint=$("$OPENSSL" x509 -in "$work/certificate.pem" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d : | tr 'A-F' 'a-f')
echo "$SECRET is set. QA certificate SHA-1: $fingerprint"
echo "Every later candidate's provenance.json must show signing.certificate_sha1 = $fingerprint."
