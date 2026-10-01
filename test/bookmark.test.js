import test from 'node:test'
import assert from 'node:assert/strict'
import { createBookmark, restoreBookmark, anchorForS } from '../src/sync/bookmark.js'
import { computeLayout } from '../src/services/layoutService.js'

function sourceOf(rows) {
  const lines = ['# 长表', '', '| a | b |', '| - | - |']
  for (let i = 0; i < rows; i += 1) lines.push(`| ${i} | y |`)
  lines.push('', '段落 A 内容', '段落 B 内容')
  return lines.join('\n')
}

test('同版本书签：直接恢复像素', () => {
  const layout = computeLayout(sourceOf(40))
  const bm = createBookmark({
    docId: 'd',
    layoutVersion: layout.version,
    sourceSignature: layout.sourceSignature,
    totalLines: 50,
    editorScrollTop: 321,
    previewScrollTop: 400,
    anchor: { s: 30, fragmentSignature: layout.fragments[0].signature, ordinal: layout.fragments[0].ordinal },
  })
  const r = restoreBookmark({
    bookmark: bm,
    fragments: layout.fragments,
    currentLayoutVersion: layout.version,
    currentSourceSignature: layout.sourceSignature,
    currentTotalLines: 50,
  })
  assert.equal(r.migrated, false)
  assert.equal(r.editorScrollTop, 321)
})

test('旧书签：分片签名在新版本中仍存在 -> 迁移到对应源行', () => {
  const oldLayout = computeLayout(sourceOf(40))
  // 新版本：同一表格但行数变化，页面分片签名对“同分片首行”保持稳定
  const newSource = sourceOf(45)
  const newLayout = computeLayout(newSource)
  const targetFrag = newLayout.fragments.find((f) => f.type === 'table')
  const bm = createBookmark({
    docId: 'd',
    layoutVersion: oldLayout.version,
    sourceSignature: 'old-sig',
    totalLines: 46,
    editorScrollTop: 500,
    previewScrollTop: 600,
    anchor: { s: 10, fragmentSignature: targetFrag.signature, ordinal: targetFrag.ordinal },
  })
  const r = restoreBookmark({
    bookmark: bm,
    fragments: newLayout.fragments,
    currentLayoutVersion: newLayout.version,
    currentSourceSignature: newLayout.sourceSignature,
    currentTotalLines: newSource.split('\n').length,
  })
  assert.equal(r.migrated, true)
  assert.equal(r.editorScrollTop, null)
  assert.ok(Math.abs(r.s - (targetFrag.startLine + targetFrag.endLine) / 2) < 1e-9)
})

test('签名完全失效：按源行比例迁移（不丢失阅读位置）', () => {
  const bm = createBookmark({
    docId: 'd',
    layoutVersion: 'very-old',
    sourceSignature: 'very-old-sig',
    totalLines: 100,
    editorScrollTop: 1,
    previewScrollTop: 2,
    anchor: { s: 50, fragmentSignature: 'deadbeef', ordinal: 999999 },
  })
  const r = restoreBookmark({
    bookmark: bm,
    fragments: [{ signature: 'other', ordinal: 1, startLine: 1, endLine: 2 }],
    currentLayoutVersion: 'new',
    currentSourceSignature: 'new-sig',
    currentTotalLines: 200,
  })
  assert.equal(r.migrated, true)
  assert.ok(Math.abs(r.s - 100) < 1e-9)
})

test('anchorForS：落在分片区间内优先，否则取最近分片', () => {
  const frags = [
    { signature: 'a', ordinal: 1, startLine: 1, endLine: 10 },
    { signature: 'b', ordinal: 2, startLine: 11, endLine: 20 },
  ]
  assert.equal(anchorForS(frags, 12).fragmentSignature, 'b')
  assert.equal(anchorForS(frags, 5).fragmentSignature, 'a')
  const far = anchorForS(frags, 99)
  assert.ok(far.fragmentSignature)
})
