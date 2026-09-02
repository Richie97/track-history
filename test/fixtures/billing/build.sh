#!/bin/sh
# Builds the synthetic certificate chains the Apple JWS verification tests use.
#
# Apple signs StoreKit 2 transactions with a leaf certificate that chains through
# the Worldwide Developer Relations CA to Apple Root CA - G3. The Worker pins
# that root (src/lib/billing/apple-roots.ts) and checks the two Apple-specific
# extension OIDs the App Store Server Library checks, so the tests need a chain
# with the same *shape* but a root we hold the key to:
#
#   root.pem          P-384 self-signed CA               (stands in for Apple Root CA - G3)
#   intermediate.pem  P-256 CA, WWDR OID 1.2.840.113635.100.6.2.1
#   leaf.pem          P-256, receipt-signing OID 1.2.840.113635.100.6.11.1
#   leaf-key.pem      the leaf's private key, so tests can sign payloads
#   leaf-noext.pem    a leaf signed by the same intermediate but WITHOUT the
#                     receipt OID — any Apple-issued cert chains to the root, so
#                     the OID check is what stops a developer cert forging a purchase
#   other-root.pem, other-intermediate.pem, other-leaf.pem, other-leaf-key.pem
#                     a complete, well-formed chain to a DIFFERENT root
#
# Validity is 100 years, so the fixtures never expire under the tests. Nothing
# here is a secret. Re-run only if the shape changes; the outputs are committed.
set -eu
cd "$(dirname "$0")"

ext() { # $1 = OID to mark, or "" for none
  printf 'basicConstraints=critical,CA:%s\nkeyUsage=critical,%s\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n' "$2" "$3"
  [ -n "$1" ] && printf '%s=DER:05:00\n' "$1"
  true
}

chain() { # $1 = file prefix ("" or "other-"), $2 = leaf OID or ""
  p="$1"
  openssl ecparam -name secp384r1 -genkey -noout -out "${p}root-key.pem"
  openssl req -new -x509 -key "${p}root-key.pem" -sha384 -days 36500 \
    -subj "/CN=Test ${p}Root CA/O=Track Evolution tests" -out "${p}root.pem" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"

  openssl ecparam -name prime256v1 -genkey -noout -out "${p}intermediate-key.pem"
  openssl req -new -key "${p}intermediate-key.pem" -subj "/CN=Test ${p}WWDR CA/O=Track Evolution tests" \
    -out "${p}intermediate.csr"
  ext "1.2.840.113635.100.6.2.1" TRUE "keyCertSign,cRLSign" > "${p}intermediate.ext"
  openssl x509 -req -in "${p}intermediate.csr" -CA "${p}root.pem" -CAkey "${p}root-key.pem" \
    -sha384 -days 36500 -set_serial 2 -extfile "${p}intermediate.ext" -out "${p}intermediate.pem"

  openssl ecparam -name prime256v1 -genkey -noout -out "${p}leaf-key.pem"
  openssl req -new -key "${p}leaf-key.pem" -subj "/CN=Test ${p}Receipt Signer/O=Track Evolution tests" \
    -out "${p}leaf.csr"
  ext "$2" FALSE "digitalSignature" > "${p}leaf.ext"
  openssl x509 -req -in "${p}leaf.csr" -CA "${p}intermediate.pem" -CAkey "${p}intermediate-key.pem" \
    -sha256 -days 36500 -set_serial 3 -extfile "${p}leaf.ext" -out "${p}leaf.pem"
  rm -f "${p}intermediate.csr" "${p}intermediate.ext" "${p}leaf.csr" "${p}leaf.ext"
}

chain "" "1.2.840.113635.100.6.11.1"
chain "other-" "1.2.840.113635.100.6.11.1"

# A leaf under the real test intermediate with no receipt-signing OID.
openssl ecparam -name prime256v1 -genkey -noout -out leaf-noext-key.pem
openssl req -new -key leaf-noext-key.pem -subj "/CN=Test Developer Cert/O=Track Evolution tests" -out leaf-noext.csr
ext "" FALSE "digitalSignature" > leaf-noext.ext
openssl x509 -req -in leaf-noext.csr -CA intermediate.pem -CAkey intermediate-key.pem \
  -sha256 -days 36500 -set_serial 4 -extfile leaf-noext.ext -out leaf-noext.pem
rm -f leaf-noext.csr leaf-noext.ext

# The CA private keys are only needed to mint the fixtures.
rm -f root-key.pem intermediate-key.pem other-root-key.pem other-intermediate-key.pem

# openssl ecparam writes SEC1 "EC PRIVATE KEY" files; WebCrypto imports PKCS#8.
for k in leaf-key leaf-noext-key other-leaf-key; do
  openssl pkcs8 -topk8 -nocrypt -in "$k.pem" -out "$k.pkcs8" && mv "$k.pkcs8" "$k.pem"
done
ls -1
