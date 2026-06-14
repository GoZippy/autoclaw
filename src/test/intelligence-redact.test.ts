/**
 * intelligence-redact.test.ts — unit tests for redactSecrets().
 *
 * Validates that common secret patterns are stripped before any text reaches
 * disk, vector store, or logs (R7.1, R7.3). Also verifies that normal code and
 * prose survive unmodified.
 */

import * as assert from 'assert';
import { redactSecrets } from '../intelligence/redact';

suite('intelligence-redact: redactSecrets', function () {

  // --- PEM private keys ---------------------------------------------------

  test('redacts RSA private key blocks', function () {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWTB4zPPMxm8q',
      'abc123def456ghi789jkl012mno345pqr678stu901vwx234=',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const input = `Config:\n${pem}\nDone.`;
    const result = redactSecrets(input);
    assert.ok(!result.includes('MIIEpAIBAAK'), 'key body must be gone');
    assert.ok(result.includes('\u2039redacted:private-key\u203a'), 'marker present');
    assert.ok(result.includes('Config:'), 'surrounding text preserved');
    assert.ok(result.includes('Done.'), 'surrounding text preserved');
  });

  test('redacts EC private key blocks', function () {
    const pem = [
      '-----BEGIN EC PRIVATE KEY-----',
      'MHQCAQEEIOdMWv+N1hW5EuT/2aZdm2mVnVkWrr0E2n0+GS',
      '-----END EC PRIVATE KEY-----',
    ].join('\n');
    const result = redactSecrets(pem);
    assert.ok(result.includes('\u2039redacted:private-key\u203a'));
    assert.ok(!result.includes('MHQCAQEEIOdM'));
  });

  // --- Bearer tokens ------------------------------------------------------

  test('redacts Authorization Bearer header value', function () {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def';
    const result = redactSecrets(input);
    assert.ok(result.includes('Bearer \u2039redacted:bearer\u203a'), `got: ${result}`);
    assert.ok(!result.includes('eyJhbGciOi'));
  });

  test('redacts standalone Bearer token reference', function () {
    const input = 'Use Bearer sk-proj-abcdefghijklmnopqrstuvwxyz1234 for auth';
    const result = redactSecrets(input);
    assert.ok(result.includes('Bearer \u2039redacted:bearer\u203a'));
  });

  // --- API key prefixes ---------------------------------------------------

  test('redacts GitHub personal access token (ghp_)', function () {
    const input = 'GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk123';
    const result = redactSecrets(input);
    assert.ok(result.includes('\u2039redacted:api-key\u203a') || result.includes('\u2039redacted:env-secret\u203a'),
      `should redact ghp_ token: ${result}`);
    assert.ok(!result.includes('ghp_ABCDEF'));
  });

  test('redacts GitHub OAuth token (gho_)', function () {
    const input = 'token: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abc';
    const result = redactSecrets(input);
    assert.ok(result.includes('\u2039redacted:api-key\u203a'));
  });

  test('redacts GitHub server token (ghs_)', function () {
    const input = 'ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abc';
    const result = redactSecrets(input);
    assert.ok(result.includes('\u2039redacted:api-key\u203a'));
  });

  test('redacts OpenAI/Stripe sk- keys', function () {
    const input = 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz12345';
    const result = redactSecrets(input);
    assert.ok(!result.includes('sk-abcdef'));
  });

  test('redacts Stripe pk_live_ keys', function () {
    const input = 'pk_live_ABCDEFGHIJKLMNOPQRSTuvwxyz1234567890';
    const result = redactSecrets(input);
    assert.ok(result.includes('\u2039redacted:api-key\u203a'));
  });

  test('redacts Stripe pk_test_ keys', function () {
    const input = 'pk_test_ABCDEFGHIJKLMNOPQRSTuvwxyz1234567890';
    const result = redactSecrets(input);
    assert.ok(result.includes('\u2039redacted:api-key\u203a'));
  });

  test('redacts AWS access key (AKIA...)', function () {
    const input = 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(input);
    assert.ok(result.includes('\u2039redacted:api-key\u203a'));
    assert.ok(!result.includes('AKIAIOSFODNN7EXAMPLE'));
  });

  test('redacts Slack xoxb- tokens', function () {
    const input = 'SLACK_TOKEN=xoxb-1234567890-abcdef';
    const result = redactSecrets(input);
    assert.ok(!result.includes('xoxb-1234567890'));
  });

  // --- .env-style secret lines --------------------------------------------

  test('redacts .env SECRET_KEY=... lines', function () {
    const input = 'SECRET_KEY=my-super-secret-value-123';
    const result = redactSecrets(input);
    assert.ok(result.includes('SECRET_KEY='));
    assert.ok(result.includes('\u2039redacted:env-secret\u203a'));
    assert.ok(!result.includes('my-super-secret'));
  });

  test('redacts .env export DB_PASSWORD="..." lines', function () {
    const input = 'export DB_PASSWORD="hunter2"';
    const result = redactSecrets(input);
    assert.ok(result.includes('\u2039redacted:env-secret\u203a'));
    assert.ok(!result.includes('hunter2'));
  });

  test('redacts .env API_TOKEN lines', function () {
    const input = 'API_TOKEN=tok_abcdef123456';
    const result = redactSecrets(input);
    assert.ok(result.includes('API_TOKEN='));
    assert.ok(result.includes('\u2039redacted:env-secret\u203a'));
    assert.ok(!result.includes('tok_abcdef'));
  });

  test('redacts AUTH_CREDENTIAL lines', function () {
    const input = 'AUTH_CREDENTIAL=someValue';
    const result = redactSecrets(input);
    assert.ok(result.includes('\u2039redacted:env-secret\u203a'));
  });

  // --- Generic long tokens ------------------------------------------------

  test('redacts generic 40+ char alphanumeric strings', function () {
    const token = 'a'.repeat(50);
    const input = `here is a token: ${token} and more text`;
    const result = redactSecrets(input);
    assert.ok(result.includes('\u2039redacted:token\u203a'));
    assert.ok(!result.includes(token));
  });

  test('redacts base64-like long strings', function () {
    const b64 = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw';
    const input = `encoded: ${b64}`;
    const result = redactSecrets(input);
    assert.ok(result.includes('\u2039redacted:token\u203a') ||
      result.includes('\u2039redacted:api-key\u203a'),
      `long base64 should be redacted: ${result}`);
  });

  // --- Non-secrets preserved ----------------------------------------------

  test('preserves short identifiers and normal code', function () {
    const input = 'const userId = "abc123";\nfunction getData() { return 42; }';
    const result = redactSecrets(input);
    assert.strictEqual(result, input, 'normal code must pass through unchanged');
  });

  test('preserves normal .env lines that do not look like secrets', function () {
    const input = 'NODE_ENV=production\nPORT=3000\nDEBUG=true';
    const result = redactSecrets(input);
    assert.strictEqual(result, input, 'non-secret env vars should pass through');
  });

  test('preserves prose and comments', function () {
    const input = [
      '// This function handles authentication flow.',
      'The quick brown fox jumps over the lazy dog.',
      'TODO: implement retry logic for network failures.',
    ].join('\n');
    const result = redactSecrets(input);
    assert.strictEqual(result, input);
  });

  test('preserves short hex hashes like git commit SHAs', function () {
    const input = 'commit abc1234def5678';
    const result = redactSecrets(input);
    assert.strictEqual(result, input, 'short hashes must not be redacted');
  });

  // --- Multiple patterns in one text --------------------------------------

  test('handles mixed secrets in a single block', function () {
    const input = [
      'SECRET_KEY=abc123xyz',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      'normal line of code here',
      'AKIAIOSFODNN7EXAMPLE',
    ].join('\n');
    const result = redactSecrets(input);
    assert.ok(result.includes('\u2039redacted:env-secret\u203a'), 'env secret');
    assert.ok(result.includes('\u2039redacted:bearer\u203a'), 'bearer');
    assert.ok(result.includes('\u2039redacted:api-key\u203a'), 'api key');
    assert.ok(result.includes('normal line of code here'), 'normal text preserved');
  });
});
