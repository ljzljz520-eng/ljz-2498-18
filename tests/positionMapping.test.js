import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSourceDocument } from '../src/core/sourceDocument.js'
import {
  deserializePosition,
  layoutPositionToSource,
  resolveBookmark,
  sourceAnchorToLayout,
} from '../src/core/positionMapping.js'

const source = `# 标题

| A | B |
| --- | --- |
| 1 | 2 |
| 3 | 4 |

文字`

function fragmentRange(nodeId, fingerprint, startLine, endLine, y, height, layoutNodeId, ratio = 0) {
  return {
    sourceNodeId: nodeId,
    sourceNodeFingerprint: fingerprint,
    sourceLineStart: startLine,
    sourceLineEnd: endLine,
    ratio,
    y,
    height,
    headingPath: [],
    layoutNodeId,
  }
}

describe('position interval mapping', () => {
  it('maps a source line in a long table to the correct layout fragment', () => {
    const model = parseSourceDocument(source)
    const table = model.nodes.find((node) => node.type === 'table')
    const bundle = {
      layoutNodes: [
        { id: 'p1', y: 0, height: 100 },
        { id: 'p2', y: 720, height: 100 },
      ],
      sourceRanges: [
        fragmentRange(table.id, table.fingerprint, table.lineStart, 5, 0, 100, 'p1'),
        fragmentRange(table.id, table.fingerprint, table.lineStart + 1, table.lineEnd, 720, 100, 'p2', 0.5),
      ],
    }

    const first = sourceAnchorToLayout(bundle, model, {
      sourceNodeId: table.id,
      sourceLine: 3,
      lineRatio: 0,
    })
    const second = sourceAnchorToLayout(bundle, model, {
      sourceNodeId: table.id,
      sourceLine: 6,
      lineRatio: 0.5,
    })

    assert.equal(first.range.layoutNodeId, 'p1')
    assert.equal(second.range.layoutNodeId, 'p2')
    assert.ok(second.y >= 720)
  })

  it('maps a preview position back to a source row without using container percentage', () => {
    const model = parseSourceDocument(source)
    const table = model.nodes.find((node) => node.type === 'table')
    const range = fragmentRange(table.id, table.fingerprint, 3, 5, 100, 150, 'p2', 0.5)
    const bundle = { layoutNodes: [{ id: 'p2', y: 100, height: 150 }], sourceRanges: [range] }

    const result = layoutPositionToSource(bundle, 175)
    assert.equal(result.anchor.sourceNodeFingerprint, table.fingerprint)
    assert.ok(result.anchor.sourceLine >= 3 && result.anchor.sourceLine <= 5)
  })

  it('corrects server coordinates using real browser measurements', () => {
    const model = parseSourceDocument(source)
    const table = model.nodes.find((node) => node.type === 'table')
    const range = fragmentRange(table.id, table.fingerprint, 3, 5, 100, 100, 'p2')
    const bundle = {
      layoutNodes: [{ id: 'p2', y: 100, height: 100 }],
      sourceRanges: [range],
    }
    const measurements = new Map([['p2', { id: 'p2', y: 140, height: 120 }]])

    const result = sourceAnchorToLayout(bundle, model, {
      sourceNodeId: table.id,
      sourceLine: 3,
      lineRatio: 0,
    }, measurements)

    assert.equal(result.y, 140)
    assert.equal(result.drift, 40)
    assert.equal(result.confidence, 'drift-corrected')
  })

  it('returns no mapping instead of inventing a percentage result', () => {
    const model = parseSourceDocument(source)
    const result = sourceAnchorToLayout({ sourceRanges: [] }, model, { sourceLine: 1 })
    assert.equal(result.confidence, 'none')
    assert.equal(result.y, null)
  })

  it('repairs an old bookmark by fingerprint and clamps moved lines', () => {
    const model = parseSourceDocument(`新内容\n${source}`)
    const heading = model.nodes.find((node) => node.type === 'heading')
    const repaired = resolveBookmark(model, {
      sourceNodeFingerprint: heading.fingerprint,
      sourceLine: heading.lineEnd + 10,
      lineRatio: 0,
    })
    assert.equal(repaired.status, 'fingerprint-repaired')
    assert.equal(repaired.anchor.sourceLine, heading.lineEnd)

    assert.equal(deserializePosition('12px'), null)
  })
})
