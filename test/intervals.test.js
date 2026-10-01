import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeRanges, rangesOverlap, rangesCoveringLine } from '../src/sync/intervals.js'

test('区间合并：相接/重叠合并，分离保留', () => {
  assert.deepEqual(
    mergeRanges([{ startLine: 1, endLine: 3 }, { startLine: 3, endLine: 5 }, { startLine: 8, endLine: 9 }]),
    [{ startLine: 1, endLine: 5 }, { startLine: 8, endLine: 9 }],
  )
})

test('覆盖行查询：长表多个分片可同时覆盖同一源行', () => {
  const frags = [
    { startLine: 5, endLine: 12 },
    { startLine: 9, endLine: 12 }, // 续页分片：区间重叠
    { startLine: 13, endLine: 14 },
  ]
  const hit = rangesCoveringLine(frags, 10)
  assert.equal(hit.length, 2)
  assert.ok(rangesOverlap(frags[0], frags[1]))
})
