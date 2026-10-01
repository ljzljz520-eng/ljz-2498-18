import test from 'node:test'
import assert from 'node:assert/strict'
import { computeLayout, createLayoutService, PAGE_HEIGHT } from '../src/services/layoutService.js'
import { parseCatalpaBlocks } from '../src/utils/catalpa.js'

function longTableSource(rows = 60) {
  const lines = ['# 标题', '', '| a | b |', '| - | - |']
  for (let i = 0; i < rows; i += 1) lines.push(`| ${i} | x${i} |`)
  lines.push('', '结尾段落')
  return lines.join('\n')
}

test('长表拆页：一个源表格产生多个布局分片，且页码递增', () => {
  const source = longTableSource(60)
  const blocks = parseCatalpaBlocks(source)
  const tableBlock = blocks.find((b) => b.type === 'table')
  assert.ok(tableBlock)

  const layout = computeLayout(source)
  const tableFrags = layout.fragments.filter((f) => f.blockId === tableBlock.id)
  assert.ok(tableFrags.length >= 2, '60 行表格应跨至少 2 页')
  assert.equal(tableFrags[0].part.of, tableFrags.length)
  assert.deepEqual(tableFrags.map((f) => f.part.index), tableFrags.map((_, i) => i))
  const pages = new Set(tableFrags.map((f) => f.page))
  assert.ok(pages.size >= 2)
  // 所有分片都指回同一个源表格节点
  assert.ok(tableFrags.every((f) => f.endLine === tableBlock.endLine))
  // 每个分片带稳定签名
  assert.ok(tableFrags.every((f) => /^[0-9a-f]{8}$/.test(f.signature)))
})

test('普通段落：多源行合并且不拆页', () => {
  const source = '# H\n\n短段落内容'
  const layout = computeLayout(source)
  const para = layout.fragments.filter((f) => f.type === 'paragraph')
  assert.equal(para.length, 1)
})

test('布局版本由内容决定：内容不变版本相同，内容变化版本改变', () => {
  const a = computeLayout('hello\nworld')
  const b = computeLayout('hello\nworld')
  const c = computeLayout('hello\nworld!')
  assert.equal(a.version, b.version)
  assert.notEqual(a.version, c.version)
})

test('服务端：failNext 注入一次失败，随后成功', async () => {
  const svc = createLayoutService({ latencyMin: 1, latencyMax: 2, rng: () => 0.5 })
  svc.failNext()
  await assert.rejects(svc.requestLayout({ docId: 'd', source: 'x' }))
  const ok = await svc.requestLayout({ docId: 'd', source: 'x' })
  assert.equal(ok.docId, 'd')
  assert.ok(ok.fragments.length > 0)
})

test('服务端：乱序模式下仍以 reqId 标识请求（裁决在客户端测试）', async () => {
  const svc = createLayoutService({ latencyMin: 10, latencyMax: 30, rng: () => 0.1 })
  svc.setMode('out-of-order')
  const [r1, r2] = await Promise.all([
    svc.requestLayout({ docId: 'd', source: 'aaaa' }),
    svc.requestLayout({ docId: 'd', source: 'bbbb' }),
  ])
  assert.notEqual(r1.reqId, r2.reqId)
})
