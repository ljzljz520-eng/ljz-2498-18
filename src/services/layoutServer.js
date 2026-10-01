import {
  escapeHtml,
  parseSourceDocument,
  renderInline,
} from '../core/sourceDocument.js'

export const LAYOUT_ENGINE_VERSION = 'mock-layout-2026.10.01'
export const PAGE_WIDTH = 760
export const PAGE_HEIGHT = 720
export const PAGE_PADDING = 28
export const GAP = 14
export const LINE_HEIGHT = 26
export const CONTENT_WIDTH = PAGE_WIDTH - PAGE_PADDING * 2

function hash32(input) {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function estimateLines(text, charsPerLine = 44) {
  return Math.max(1, Math.ceil(text.length / charsPerLine))
}

function imageCount(text) {
  return (text.match(/!\[[^\]]*\]\([^)\s]+/g) || []).length
}

function range(node, lineStart = node.lineStart, lineEnd = node.lineEnd, ratio = 0, y = 0, height = 0, innerY = y, innerHeight = height) {
  return {
    sourceNodeId: node.id,
    sourceNodeFingerprint: node.fingerprint,
    sourceLineStart: lineStart,
    sourceLineEnd: lineEnd,
    ratio,
    y,
    height,
    innerY,
    innerHeight,
    headingPath: node.headingPath || [],
  }
}

function measureNode(node) {
  switch (node.type) {
    case 'heading':
      return Math.round(34 + Math.max(0, 5 - node.level) * 3) + GAP
    case 'hr':
      return 20 + GAP
    case 'quote':
      return estimateLines(node.text, 38) * LINE_HEIGHT + 18 + GAP
    case 'list':
      return node.items.length * 30 + GAP
    case 'code':
      return node.lineCount * 22 + 42 + GAP
    case 'table':
      return (node.rows.length + 1) * 44 + GAP
    case 'paragraph':
      return estimateLines(node.text, imageCount(node.text) ? 34 : 46) * LINE_HEIGHT +
        imageCount(node.text) * 90 + GAP
    default:
      return LINE_HEIGHT + GAP
  }
}

function createPage(number) {
  return { pageNumber: number, height: 0, nodes: [] }
}

function addRange(target, sourceRange) {
  if (!target.some((item) =>
    item.sourceNodeId === sourceRange.sourceNodeId &&
    item.sourceLineStart === sourceRange.sourceLineStart &&
    item.sourceLineEnd === sourceRange.sourceLineEnd)) {
    target.push(sourceRange)
  }
}

function splitAcrossPages(docNode, measuredHeight, pages) {
  const available = PAGE_HEIGHT - pages[pages.length - 1].height
  if (measuredHeight <= available) {
    pages[pages.length - 1].nodes.push({
      id: `${docNode.id}@p${pages[pages.length - 1].pageNumber}`,
      type: docNode.type,
      sourceNodeId: docNode.id,
      sourceNodeFingerprint: docNode.fingerprint,
      pageNumber: pages[pages.length - 1].pageNumber,
      y: pages[pages.length - 1].height,
      height: measuredHeight,
      sourceRanges: [range(docNode)],
      docNode,
    })
    pages[pages.length - 1].height += measuredHeight
    return
  }

  if (docNode.type === 'table') {
    const headerHeight = 44
    const rowHeight = 44
    const partGap = GAP
    let rowIndex = 0
    while (rowIndex < docNode.rows.length) {
      let page = pages[pages.length - 1]
      const required = headerHeight + rowHeight + partGap
      if (PAGE_HEIGHT - page.height < required && page.nodes.length > 0) {
        pages.push(createPage(pages.length + 1))
        page = pages[pages.length - 1]
      }
      const rowsLeft = docNode.rows.length - rowIndex
      const rowsOnPage = Math.max(1, Math.min(
        rowsLeft,
        Math.floor((PAGE_HEIGHT - page.height - headerHeight - partGap) / rowHeight),
      ))
      const isStart = rowIndex === 0
      const endLine = docNode.rows[rowIndex + rowsOnPage - 1].line
      const height = headerHeight + rowsOnPage * rowHeight + partGap
      const bodyTop = headerHeight
      const bodyHeight = rowsOnPage * rowHeight
      const sourceRanges = isStart
        ? [range(docNode, docNode.lineStart, endLine, 0, 0, height, 0, bodyTop + bodyHeight)]
        : [
            range(docNode, docNode.lineStart, docNode.lineStart + 1, 0, 0, height, 0, headerHeight),
            range(docNode, docNode.rows[rowIndex].line, endLine,
              rowIndex / docNode.rows.length, 0, height, bodyTop, bodyHeight),
          ]
      page.nodes.push({
        id: isStart
          ? `${docNode.id}@p${page.pageNumber}`
          : `${docNode.id}@p${page.pageNumber}#${rowIndex}`,
        type: 'table',
        sourceNodeId: docNode.id,
        sourceNodeFingerprint: docNode.fingerprint,
        pageNumber: page.pageNumber,
        y: page.height,
        height,
        sourceRanges,
        docNode,
        tablePart: {
          isStart,
          isContinuation: !isStart,
          rowStart: rowIndex,
          rowEnd: rowIndex + rowsOnPage,
        },
      })
      page.height += height
      rowIndex += rowsOnPage
      if (rowIndex < docNode.rows.length) pages.push(createPage(pages.length + 1))
    }
    return
  }

  let remaining = measuredHeight
  const totalUnits = Math.max(1, docNode.lineEnd - docNode.lineStart + 1)
  let startUnit = 0
  while (remaining > 1) {
    const page = pages[pages.length - 1]
    const capacity = PAGE_HEIGHT - page.height
    const partHeight = Math.min(remaining, capacity)
    const units = Math.min(
      totalUnits - startUnit,
      Math.max(1, Math.floor((partHeight / measuredHeight) * totalUnits)),
    )
    const endUnit = Math.min(totalUnits, startUnit + units)
    const realHeight = Math.min(partHeight, measuredHeight * ((endUnit - startUnit) / totalUnits))
    const lineStart = docNode.lineStart + startUnit
    const lineEnd = Math.min(docNode.lineEnd, docNode.lineStart + endUnit - 1)
    const part = {
      id: startUnit === 0 ? `${docNode.id}@p${page.pageNumber}` : `${docNode.id}@p${page.pageNumber}#${lineStart}`,
      type: docNode.type,
      sourceNodeId: docNode.id,
      sourceNodeFingerprint: docNode.fingerprint,
      pageNumber: page.pageNumber,
      y: page.height,
      height: realHeight,
      sourceRanges: [range(docNode, lineStart, lineEnd, startUnit / totalUnits, 0, realHeight)],
      docNode,
    }
    if (startUnit > 0) part.continuation = true
    page.nodes.push(part)
    page.height += realHeight
    remaining -= realHeight
    startUnit = endUnit
    if (remaining > 1) pages.push(createPage(pages.length + 1))
  }
}

function buildLayoutModel(doc) {
  const pages = [createPage(1)]
  for (const node of doc.nodes) {
    const height = measureNode(node)
    if (pages[pages.length - 1].height + height > PAGE_HEIGHT &&
      pages[pages.length - 1].nodes.length > 0) {
      pages.push(createPage(pages.length + 1))
    }
    splitAcrossPages(node, height, pages)
    if (pages[pages.length - 1].height >= PAGE_HEIGHT - 4 && node !== doc.nodes[doc.nodes.length - 1]) {
      pages.push(createPage(pages.length + 1))
    }
  }

  let globalY = 0
  for (const page of pages) {
    for (const layoutNode of page.nodes) {
      const localY = layoutNode.y
      layoutNode.y = globalY + localY
      for (const sourceRange of layoutNode.sourceRanges) {
        sourceRange.y = layoutNode.y + (sourceRange.innerY ?? localY) - localY
        sourceRange.height = sourceRange.innerHeight ?? layoutNode.height
      }
    }
    globalY += PAGE_HEIGHT
  }
  return pages
}

function renderTable(layoutNode) {
  const { docNode, tablePart } = layoutNode
  const start = tablePart?.rowStart ?? 0
  const end = tablePart?.rowEnd ?? docNode.rows.length
  const head = `<tr>${docNode.headers.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr>`
  const rows = docNode.rows.slice(start, end).map((row) =>
    `<tr>${row.cells.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('')
  return `<div class="layout-node table-node" data-layout-id="${layoutNode.id}" data-source-id="${docNode.id}">
    ${tablePart?.isContinuation ? '<div class="continuation-note">（接上页）</div>' : ''}
    <table><thead>${head}</thead><tbody>${rows}</tbody></table>
  </div>`
}

function renderNode(layoutNode) {
  const node = layoutNode.docNode
  const common = `class="layout-node ${node.type}-node" data-layout-id="${layoutNode.id}" data-source-id="${node.id}"`
  if (node.type === 'table') return renderTable(layoutNode)
  if (node.type === 'heading') return `<h${node.level} ${common}>${renderInline(node.text)}</h${node.level}>`
  if (node.type === 'hr') return `<hr ${common} />`
  if (node.type === 'quote') return `<blockquote ${common}>${node.lines.map((line) => renderInline(line)).join('<br>')}</blockquote>`
  if (node.type === 'list') {
    const tag = node.ordered ? 'ol' : 'ul'
    return `<${tag} ${common}>${node.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`
  }
  if (node.type === 'code') {
    const lines = node.text.split('\n')
    const visible = layoutNode.continuation
      ? lines.slice(
        layoutNode.sourceRanges[0].sourceLineStart - node.lineStart - 1,
        layoutNode.sourceRanges[0].sourceLineEnd - node.lineStart,
      )
      : lines
    return `<div ${common} data-foldable="${node.foldable ? 'true' : 'false'}">
      <div class="code-title"><span>${escapeHtml(node.language || 'text')}</span>${node.foldable ? '<button type="button" class="fold-button" aria-expanded="true">折叠</button>' : ''}</div>
      <pre><code>${escapeHtml(visible.join('\n'))}</code></pre>
    </div>`
  }
  return `<p ${common}>${renderInline(node.text)}</p>`
}

function renderPages(pages) {
  return pages.map((page) =>
    `<section class="document-page" data-page="${page.pageNumber}">${page.nodes.map(renderNode).join('')}</section>`
  ).join('<div class="page-gap"></div>')
}

function summarizeRanges(nodes) {
  const sourceRanges = []
  const layoutNodes = []
  for (const node of nodes.flatMap((page) => page.nodes)) {
    layoutNodes.push({
      id: node.id,
      type: node.type,
      sourceNodeId: node.sourceNodeId,
      sourceNodeFingerprint: node.sourceNodeFingerprint,
      pageNumber: node.pageNumber,
      y: node.y,
      height: node.height,
      sourceRanges: node.sourceRanges.map((range) => ({
        sourceNodeId: range.sourceNodeId,
        sourceNodeFingerprint: range.sourceNodeFingerprint,
        sourceLineStart: range.sourceLineStart,
        sourceLineEnd: range.sourceLineEnd,
        ratio: range.ratio,
        y: range.y,
        height: range.height,
        innerY: range.innerY ?? range.y,
        innerHeight: range.innerHeight ?? range.height,
        headingPath: range.headingPath,
      })),
    })
    node.sourceRanges.forEach((sourceRange) => addRange(sourceRanges, { ...sourceRange, layoutNodeId: node.id }))
  }
  return { layoutNodes, sourceRanges }
}

/**
 * Simulates an asynchronous rendering backend. Deliberately allows out-of-order
 * completion; callers retain a request id and only accept the newest response.
 */
export function renderLayout(source, { signal } = {}) {
  const latency = 40 + Math.round(Math.random() * 180)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const doc = parseSourceDocument(source)
      const pages = buildLayoutModel(doc)
      const summary = summarizeRanges(pages)
      resolve({
        layoutVersion: hash32(`${LAYOUT_ENGINE_VERSION}:${doc.sourceRevisionHash}`),
        engine: LAYOUT_ENGINE_VERSION,
        sourceRevisionHash: doc.sourceRevisionHash,
        page: { width: PAGE_WIDTH, height: PAGE_HEIGHT, padding: PAGE_PADDING, gap: GAP },
        html: renderPages(pages),
        sourceNodes: doc.nodes.map(({ id, type, lineStart, lineEnd, text, fingerprint, headingPath, level, rows, headers, items }) => ({
          id, type, lineStart, lineEnd, text, fingerprint, headingPath, level, rows, headers, items,
        })),
        ...summary,
      })
    }, latency)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    }
  })
}
