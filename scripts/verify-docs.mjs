#!/usr/bin/env node
/**
 * verify-docs - bilingual documentation consistency gate for this package.
 *
 * The package ships two README sides that carry equal authority, plus the
 * README.i18n.yaml pairing record: the git blob hash of each side as of the
 * last confirmed-consistent state. This gate re-checks that record and the
 * structural mirror between the two sides.
 *
 * Usage:
 *   node scripts/verify-docs.mjs              # check (CI mode)
 *   node scripts/verify-docs.mjs --list       # report state, never fails
 *   node scripts/verify-docs.mjs --write      # re-record the pairing hashes
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const writeMode = args.includes('--write')

const failures = []
const fail = (msg) => { failures.push(msg) }

/** Git blob hash of a working-tree file (content-addressed, no staging needed). */
function blobHash(file) {
  return execFileSync('git', ['hash-object', file], { cwd: root }).toString().trim()
}

/** Parse a pairing record into { README.md: hash, README.zh.md: hash }. */
function readPairing(yamlPath) {
  const out = {}
  for (const line of readFileSync(yamlPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(README(?:\.zh)?\.md):\s*([0-9a-f]{40})\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

/** Write the pairing record. */
function writePairing(yamlPath, record) {
  const header = [
    '# Bilingual-pair consistency record (docs/i18n.md): the git blob hash of each'
    , '# side as of the last confirmed-consistent state. Both languages carry equal authority;'
    , '# after editing either side, bring the other along and re-record with:'
    , '#   node scripts/verify-docs.mjs --write'
  ].join('\n')
  const body = ['README.md: ' + (record['README.md'] || ''), 'README.zh.md: ' + (record['README.zh.md'] || '')].join('\n')
  writeFileSync(yamlPath, header + '\n' + body + '\n')
}

/** Structural signature: heading levels, fence count, list kinds, table rows. */
function signature(text) {
  const lines = text.split(/\r?\n/)
  return {
    headings: lines.filter((l) => /^#{1,6} /.test(l)).map((l) => l.replace(/[^#]/g, '').length),
    fences: (text.match(/^```/gm) || []).length,
    lists: lines.filter((l) => /^\s*[-*] /.test(l)).length,
    tables: lines.filter((l) => /^\|/.test(l)).length,
  }
}

const enPath = resolve(root, 'README.md')
const zhPath = resolve(root, 'README.zh.md')
const yamlPath = resolve(root, 'README.i18n.yaml')

if (!existsSync(enPath) || !existsSync(zhPath) || !existsSync(yamlPath)) {
  fail('the README pair or its pairing record is missing')
} else {
  const en = readFileSync(enPath, 'utf8')
  const zh = readFileSync(zhPath, 'utf8')
  const enSig = signature(en)
  const zhSig = signature(zh)
  if (JSON.stringify(enSig) !== JSON.stringify(zhSig)) {
    fail('the two README sides do not mirror each other structurally: ' + JSON.stringify({ enSig, zhSig }))
  }
  for (const side of [en, zh]) {
    if (!/\]\((README\.md|README\.zh\.md)\)/.test(side) && !/\]\(README[^)]*\)/.test(side)) {
      fail('a README side does not link to its counterpart')
    }
  }
  if (writeMode) {
    writePairing(yamlPath, { 'README.md': blobHash(enPath), 'README.zh.md': blobHash(zhPath) })
    console.log('re-recorded the README pairing hashes')
  } else {
    const record = readPairing(yamlPath)
    const current = { 'README.md': blobHash(enPath), 'README.zh.md': blobHash(zhPath) }
    for (const [file, hash] of Object.entries(current)) {
      if (record[file] === undefined) {
        fail(file + ' has no recorded pairing hash')
      } else if (record[file] !== hash) {
        fail(file + ' changed since the pairing was recorded - re-record with --write')
      }
    }
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error('FAIL: ' + f)
  if (!listOnly) process.exit(1)
} else {
  console.log('docs OK')
}
