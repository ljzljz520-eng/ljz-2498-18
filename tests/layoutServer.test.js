import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSourceDocument } from '../src/core/sourceDocument.js'
import { renderLayout, PAGE_HEIGHT } from '../src/services/layoutServer.js'

describe('layout server', () => {
  it('splits one source table into multiple layout fragments', async () => {
    const rows = Array.from({ length: 80 }, (_, index) =>
      `| ${index + 1} | 长内容 ${index} | ${index % 2 ? 'B' : 'A'} |`)
    const source = `# 长表\n| A | B | C |\n| --- | --- | --- |\n${rows.join('\n')}`
    const result = await renderLayout(source)

    assert.ok(result.layoutVersion)
    const table = parseSourceDocument(source).nodes.find((node) => node.type === 'table')
    const tableRanges = result.sourceRanges.filter((range) =>
      range.sourceNodeFingerprint === table.fingerprint)
    assert.ok(tableRanges.length > 1)
    const continuationNode = result.layoutNodes.find((node) => node.id.includes('#'))
    assert.ok(continuationNode)
    assert.ok(continuationNode.sourceRanges.some((item) => item.sourceLineStart === table.lineStart))
    assert.ok(continuationNode.sourceRanges.some((item) => item.sourceLineStart > table.lineStart + 1))
  })

  it('keeps a paragraph composed from several source lines as one source node', async () => {
    const result = await renderLayout('第一段第一行\n第一段第二行\n\n第二段')
    assert.equal(result.sourceNodes[0].type, 'paragraph')
    assert.equal(result.sourceNodes[0].lineStart, 1)
    assert.equal(result.sourceNodes[0].lineEnd, 2)
  })

  it('rejects an aborted rendering request', async () => {
    const controller = new AbortController()
    const promise = renderLayout('# abort', { signal: controller.signal })
    controller.abort()
    await assert.rejects(promise, (error) => error.name === 'AbortError')
  })
})
