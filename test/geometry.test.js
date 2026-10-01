import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEditorAnchors, buildPreviewAnchors, createGeometry } from '../src/sync/geometry.js'

test('编辑器锚点：每行一个，折叠行（null）不影响其它行定位', () => {
  const lineTops = []
  for (let i = 0; i < 5; i += 1) {
    lineTops.push({ top: i * 20, height: 20 })
  }
  lineTops[2] = null // 第 3 行被折叠
  const anchors = buildEditorAnchors(lineTops)
  const geo = createGeometry({ anchors, contentHeight: 102, viewportHeight: 50, totalLines: 5 })
  // 第 1 行中心 y=10
  assert.ok(Math.abs(geo.yToS(10) - 1) < 1e-9)
  // 第 5 行中心 y=90
  assert.ok(Math.abs(geo.yToS(90) - 5) < 1e-9)
})

test('预览锚点：一个段落由多个源行组成 -> 单个宽锚点', () => {
  const anchors = buildPreviewAnchors([
    { blockId: 'p1', startLine: 4, endLine: 8, top: 100, height: 60 },
  ])
  const geo = createGeometry({ anchors, contentHeight: 200, viewportHeight: 80, totalLines: 8 })
  // 段落中心 y=130 -> 源行中心 6
  assert.ok(Math.abs(geo.yToS(130) - 6) < 1e-9)
  assert.ok(Math.abs(geo.sToY(6) - 130) < 1e-1)
})

test('预览锚点：同一源表格的多个拆页分片按高度比例分布 y', () => {
  const pts = buildPreviewAnchors(
    [{ blockId: 't1', startLine: 10, endLine: 80, top: 0, height: 300 }],
    [
      { blockId: 't1', part: { index: 0, of: 2 }, startLine: 10, endLine: 80, height: 700 },
      { blockId: 't1', part: { index: 1, of: 2 }, startLine: 12, endLine: 80, height: 300 },
    ],
  )
  // 总分片高度 1000 -> 实测 300；第一分片中心 y=105，第二分片 y=255
  assert.ok(pts.some((p) => Math.abs(p.y - 105) < 1e-6 && Math.abs(p.x - 45) < 1e-6))
  assert.ok(pts.some((p) => Math.abs(p.y - 255) < 1e-6 && Math.abs(p.x - 46) < 1e-6))
})

test('无映射降级几何：s→y 走线性比例', () => {
  const geo = createGeometry({
    anchors: [{ x: 0, y: 0 }, { x: 10.5, y: 1000 }],
    contentHeight: 1000,
    viewportHeight: 200,
    totalLines: 10,
    hasMapping: false,
  })
  assert.ok(Math.abs(geo.sToY(5) - 1000 * 5 / 10.5) < 1e-9)
})
