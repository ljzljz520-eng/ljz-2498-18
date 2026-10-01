import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLinearMapper, buildInverseMapper } from '../src/sync/linear.js'

test('线性映射器：锚点处精确、区间内插值、区间外钳制', () => {
  const m = buildLinearMapper([
    { x: 0, y: 0 },
    { x: 10, y: 100 },
    { x: 20, y: 150 },
  ])
  assert.equal(m.map(0), 0)
  assert.equal(m.map(10), 100)
  assert.equal(m.map(20), 150)
  assert.equal(m.map(5), 50)
  assert.equal(m.map(15), 125)
  // 区间外钳制（不外推）
  assert.equal(m.map(30), 150)
  assert.equal(m.map(-5), 0)
})

test('反函数：y 回算 x 与原函数一致', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 4, y: 40 },
    { x: 9, y: 90 },
  ]
  const fwd = buildLinearMapper(pts)
  const inv = buildInverseMapper(pts)
  for (const x of [0, 2, 4, 6.5, 9]) {
    assert.ok(Math.abs(inv.map(fwd.map(x)) - x) < 1e-9)
  }
})

test('重复 x 去重，空点集返回 null', () => {
  const m = buildLinearMapper([{ x: 1, y: 2 }, { x: 1, y: 9 }])
  assert.equal(m.map(1), 2)
  const empty = buildLinearMapper([])
  assert.equal(empty.map(3), null)
})
