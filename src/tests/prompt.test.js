import test from 'node:test'
import assert from 'node:assert/strict'
import { parseNumbers } from '../prompt.js'

test('parseNumbers expands ranges and removes duplicates', () => {
  assert.deepEqual([...parseNumbers('1,3-5,5', 6)], [1, 3, 4, 5])
})

test('parseNumbers ignores values outside the valid range', () => {
  assert.equal(parseNumbers('0,7,abc', 6), null)
  assert.deepEqual([...parseNumbers('2-4,9', 6)], [2, 3, 4])
})

test('parseNumbers rejects reversed ranges', () => {
  assert.equal(parseNumbers('4-2', 6), null)
})