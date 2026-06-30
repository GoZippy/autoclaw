#!/usr/bin/env node
/**
 * check-changelog.js - release guard.
 *
 * Fails when package.json has a version that is not represented by a top-level
 * changelog section. This keeps marketplace metadata from showing a stale
 * changelog after a version bump.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(root, 'changelog.md'), 'utf8');
const heading = `## [${pkg.version}]`;

if (!changelog.includes(heading)) {
  console.error(`[check-changelog] missing changelog section: ${heading}`);
  process.exit(1);
}

console.log(`[check-changelog] OK - ${heading}`);
