// ZIPPY OPEN MATERIAL
//
// The Ed25519 PUBLIC key used to verify AutoClaw commercial license keys.
// This is safe to ship — it can only VERIFY signatures, never create them.
// The matching private key is held only by Zippy Technologies LLC and is used
// by scripts/sign-license.js to issue keys. NEVER commit the private key.
//
// To rotate: generate a new keypair, replace this PEM, and re-issue keys.

export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA0qqP/0KT8J/HjumvP/2E4j5iwQ8CCM+IjGByywonabg=
-----END PUBLIC KEY-----`;
