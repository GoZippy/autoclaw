#!/usr/bin/env node
// ZIPPY OPEN MATERIAL (the tool is open; the private key it needs is not)
//
// Issue an AutoClaw commercial license key. MAINTAINER-ONLY: requires the
// Ed25519 private key, which is NOT in this repo. Run this after a Square
// purchase to mint a key, then email it to the customer.
//
// Usage:
//   AUTOCLAW_LICENSE_PRIVATE_KEY=/path/to/private-key.pem \
//     node scripts/sign-license.js --tier pro --email a@b.com --days 365 [--seats 1]
//
//   tier:  pro | teams | enterprise   (default pro)
//   seats: integer                    (default 1, or 5 for teams)
//   days:  validity in days, or 0 / "perpetual" for no expiry (default 365)
//
// The matching PUBLIC key must be the one embedded in
// src/licensing/publicKey.ts, or issued keys won't verify.

const fs = require('fs');
const crypto = require('crypto');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const keyPath = process.env.AUTOCLAW_LICENSE_PRIVATE_KEY || arg('key', '');
if (!keyPath) {
  console.error('ERROR: set AUTOCLAW_LICENSE_PRIVATE_KEY=/path/to/private-key.pem (or --key <path>)');
  process.exit(1);
}
const privateKeyPem = fs.readFileSync(keyPath, 'utf8');

const tier = arg('tier', 'pro');
if (!['pro', 'teams', 'enterprise'].includes(tier)) {
  console.error(`ERROR: invalid tier "${tier}" (pro | teams | enterprise)`);
  process.exit(1);
}
const seats = parseInt(arg('seats', tier === 'teams' ? '5' : '1'), 10);
const email = arg('email', '');
const daysRaw = arg('days', '365');
const perpetual = daysRaw === '0' || daysRaw === 'perpetual';

const iat = Math.floor(Date.now() / 1000);
const exp = perpetual ? null : iat + parseInt(daysRaw, 10) * 86400;

const payload = { v: 1, tier, seats, email, iat, exp };
const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
const sig = crypto.sign(null, Buffer.from(payloadB64, 'utf8'), privateKeyPem);
const key = `AUTOCLAW-${payloadB64}.${b64url(sig)}`;

console.log('\nPayload:', JSON.stringify(payload, null, 2));
console.log('\nLicense key (send this to the customer):\n');
console.log(key);
console.log('');
