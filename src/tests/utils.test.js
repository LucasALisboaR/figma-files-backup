import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeName } from '../utils.js'

test('sanitizeName removes invalid Windows filename characters', () => {
  assert.equal(sanitizeName('Design/System:Final?'), 'Design_System_Final_')
})

test('sanitizeName prevents path segments and reserved device names', () => {
  assert.equal(sanitizeName('.'), 'sem-nome')
  assert.equal(sanitizeName('..'), 'sem-nome')
  assert.equal(sanitizeName('CON.txt'), 'sem-nome')
})

test('sanitizeName normalizes whitespace, truncates, and handles empty values', () => {
  assert.equal(sanitizeName('  Design   System  '), 'Design System')
  assert.equal(sanitizeName(''), 'sem-nome')
  assert.equal(sanitizeName('a'.repeat(120)).length, 100)
})