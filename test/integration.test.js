import test from 'node:test'
import assert from 'node:assert/strict'
import { computeLayout } from '../src/services/layoutService.js'
import { parseCatalpaBlocks } from '../src/utils/catalpa.js'
import { buildPreviewAnchors, createGeometry, buildEditorAnchors } from '../src/sync/geometry.js'

test('集成：长表跨页的布局分片，经“实测×后端索引”混合锚点后映射连续无跳变', () => {
  const rows = 60
  const lines = ['# 标题', '', '| a | b |', '| - | - |']
  for (let i = 0; i < rows; i += 1) lines.push(`| ${i} | x |`)
  lines.push('', '表后段落')
  const source = lines.join('\n')

  const layout = computeLayout(source)
  const blocks = parseCatalpaBlocks(source)
  const tableBlock = blocks.find((b) => b.type === 'table')
  const tableFrags = layout.fragments.filter((f) => f.blockId === tableBlock.id)
  assert.ok(tableFrags.length >= 2)

  // 模拟浏览器实测：整块在预览中高度 1200px（与后端版芯估算不同 → 需要误差校正/比例归一）
  const measured = blocks.map((b, i) => {
    const height = b.type === 'table' ? 1200 : 80
    return {
      blockId: b.id,
      startLine: b.startLine,
      endLine: b.endLine,
      top: i * 90 + (b.type === 'table' ? 90 : 0),
      height: b.type === 'table' ? 1200 : 80,
    }
  }).reduce((acc, m, i) => {
    // 让 top 连续累加
    const prev = acc[i - 1]
    m.top = prev ? prev.top + prev.height : 0
    acc.push(m)
    return acc
  }, [])

  const anchors = buildPreviewAnchors(measured, layout.fragments)
  const totalLines = source.split('\n').length
  const geo = createGeometry({ anchors, contentHeight: 2000, viewportHeight: 300, totalLines })

  // 表格覆盖的源行区间内，随 s 增加 y 单调不减（不能因拆页回跳）
  let prevY = -Infinity
  for (let s = tableBlock.startLine; s <= tableBlock.endLine; s += 0.5) {
    const y = geo.sToY(s)
    assert.ok(y >= prevY - 1e-6, `s=${s} 处 y 回跳: ${y} < ${prevY}`)
    prevY = y
  }

  // 编辑器侧（每行 22px）与预览侧的跨容器同步：编辑器焦点 -> 预览焦点落在同一表行
  const editorAnchors = buildEditorAnchors(
    Array.from({ length: totalLines }, (_, i) => ({ top: i * 22, height: 22 })),
  )
  const egeo = createGeometry({ anchors: editorAnchors, contentHeight: totalLines * 22, viewportHeight: 300, totalLines })

  const sTarget = tableBlock.startLine + 20
  const editorY = egeo.sToY(sTarget)
  const backFromEditor = egeo.yToS(editorY)
  const previewY = geo.sToY(backFromEditor)
  const backFromPreview = geo.yToS(previewY)
  assert.ok(Math.abs(backFromPreview - sTarget) < 0.6,
    `跨容器往返源行误差过大: ${backFromPreview} vs ${sTarget}`)
})
