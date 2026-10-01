// Catalpa 解析器：源码与“排版服务”共用同一份块级语法定义，
// 保证渲染后端返回的布局节点总能对应到这里产生的源节点。
import { fnv1a } from './hash.js'

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInline(text) {
  return text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      '<img src="$2" alt="$1" title="$3" loading="lazy" />')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

function isDelimiter(line) {
  return /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())
}

function isFence(line) {
  return /^```/.test(line.trim())
}

function isHeading(line) {
  return /^#{1,6}\s+/.test(line.trim())
}

function isQuote(line) {
  return /^>\s?/.test(line.trim())
}

function listTagFor(line) {
  if (/^\s*[-*+]\s+/.test(line)) return 'ul'
  if (/^\s*\d+\.\s+/.test(line)) return 'ol'
  return ''
}

function stripListPrefix(line) {
  return line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
}

// GFM 风格表格：表头行 + 由 | 组成的分隔行
function parseTableAlign(divider) {
  return divider
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim())
    .map((cell) => {
      const left = cell.startsWith(':')
      const right = cell.endsWith(':')
      if (left && right) return 'center'
      if (right) return 'right'
      if (left) return 'left'
      return null
    })
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim())
}

function makeBlock(type, startLine, endLine, extra = {}) {
  return {
    id: `blk-${fnv1a(`${type}:${startLine}:${endLine}`)}`,
    type,
    startLine,
    endLine,
    ...extra,
  }
}

// 解析为带源行区间的块节点数组（1-based，闭区间，空行也计入行号）
export function parseCatalpaBlocks(source) {
  const lines = source.split(/\r?\n/)
  const blocks = []
  let i = 0

  const paragraphBreak = (line) =>
    line.trim() === '' ||
    isFence(line) ||
    isHeading(line) ||
    isQuote(line) ||
    isDelimiter(line) ||
    !!listTagFor(line)

  while (i < lines.length) {
    const rawLine = lines[i]
    const line = rawLine.trimEnd()

    if (line.trim() === '') {
      i += 1
      continue
    }

    // 代码块（可折叠，超过阈值行时标记 foldable）
    if (isFence(line)) {
      const start = i + 1
      const language = line.trim().slice(3).trim()
      i += 1
      const codeLines = []
      while (i < lines.length && !isFence(lines[i])) {
        codeLines.push(lines[i])
        i += 1
      }
      const end = i // 结束围栏所在行；若没有围栏则为文档末
      i += 1
      blocks.push(makeBlock('code', start, end, {
        language,
        code: codeLines.join('\n'),
        foldable: codeLines.length > 8,
      }))
      continue
    }

    if (isHeading(line)) {
      const head = line.trim()
      const level = head.match(/^#{1,6}/)[0].length
      const text = head.replace(/^#{1,6}\s+/, '').trim()
      blocks.push(makeBlock('heading', i + 1, i + 1, { level, text }))
      i += 1
      continue
    }

    if (isQuote(line)) {
      const start = i + 1
      const quoteLines = []
      while (i < lines.length && isQuote(lines[i])) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push(makeBlock('quote', start, i, { lines: quoteLines }))
      continue
    }

    if (isDelimiter(line)) {
      blocks.push(makeBlock('hr', i + 1, i + 1))
      i += 1
      continue
    }

    const tag = listTagFor(line)
    if (tag) {
      const start = i + 1
      const items = []
      while (i < lines.length && listTagFor(lines[i]) === tag) {
        items.push(stripListPrefix(lines[i].trim()))
        i += 1
      }
      blocks.push(makeBlock('list', start, i, { tag, items }))
      continue
    }

    // 表格：当前行含 |，且下一行为合法分隔行
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const start = i + 1
      const header = splitRow(line)
      const align = parseTableAlign(lines[i + 1])
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]))
        i += 1
      }
      blocks.push(makeBlock('table', start, i, { header, align, rows }))
      continue
    }

    // 段落：连续普通行合并为一个块（一个预览段落 ← 多个源行/源节点）
    const start = i + 1
    const paragraphLines = []
    while (i < lines.length && !paragraphBreak(lines[i])) {
      paragraphLines.push(lines[i].trim())
      i += 1
    }
    blocks.push(makeBlock('paragraph', start, i, { lines: paragraphLines }))
  }

  return blocks
}

function renderTable(block) {
  const alignStyle = (a) => (a ? ` style="text-align:${a}"` : '')
  const headCells = block.header
    .map((cell, idx) => `<th${alignStyle(block.align[idx])}>${renderInline(escapeHtml(cell))}</th>`)
    .join('')
  const bodyRows = block.rows
    .map((row) => {
      const cells = row
        .map((cell, idx) => `<td${alignStyle(block.align[idx])}>${renderInline(escapeHtml(cell))}</td>`)
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('')
  return `<div class="table-wrap"><table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`
}

export function renderBlock(block) {
  switch (block.type) {
    case 'heading':
      return `<h${block.level}>${renderInline(escapeHtml(block.text))}</h${block.level}>`
    case 'quote':
      return `<blockquote>${block.lines.map((l) => renderInline(escapeHtml(l))).join('<br />')}</blockquote>`
    case 'hr':
      return '<hr />'
    case 'list':
      return `<${block.tag}>${block.items.map((t) => `<li>${renderInline(escapeHtml(t))}</li>`).join('')}</${block.tag}>`
    case 'code': {
      const langClass = block.language ? ` language-${block.language}` : ''
      const toggle = block.foldable ? '<button type="button" class="fold-toggle" aria-expanded="true">折叠代码</button>' : ''
      return `<div class="code-block">${toggle}<pre><code class="${langClass.trim()}">${escapeHtml(block.code)}</code></pre></div>`
    }
    case 'table':
      return renderTable(block)
    case 'paragraph':
      return `<p>${renderInline(escapeHtml(block.lines.join(' ')))}</p>`
    default:
      return ''
  }
}

// 输出带块锚点的 HTML；data-block-id 是 DOM 到源节点映射的稳定抓手
export function renderCatalpa(source) {
  const blocks = parseCatalpaBlocks(source)
  return blocks
    .map((b) => `<div class="src-block" data-block-id="${b.id}" data-start-line="${b.startLine}" data-end-line="${b.endLine}">${renderBlock(b)}</div>`)
    .join('\n')
}
