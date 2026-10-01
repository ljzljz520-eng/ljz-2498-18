export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderInline(text) {
  const escaped = escapeHtml(text)
  return escaped
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (_match, alt, src, title) => {
        const safeSrc = /^(https?:|data:|\/)/.test(src) ? src : '#'
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
        return `<img class="doc-image" src="${safeSrc}" alt="${escapeHtml(alt)}" loading="lazy"${titleAttr}>`
      })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/g,
      (_match, label, href) => `<a href="${href}" target="_blank" rel="noopener">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

const CONTAINER_TYPES = new Set(['paragraph', 'heading', 'quote', 'list', 'code', 'table', 'hr'])

function isTableStart(lines, index) {
  if (index + 1 >= lines.length) return false
  const first = lines[index].trim()
  const second = lines[index + 1].trim()
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(second) && first.includes('|')
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function stableHash(text) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function makeNode(type, lineStart, lineEnd, text, extra = {}) {
  const content = text.trim()
  return {
    id: `${type}-${lineStart}-${stableHash(content || type)}`,
    type,
    lineStart,
    lineEnd,
    text: content,
    fingerprint: stableHash(`${type}:${content}`),
    headingPath: [],
    ...extra,
  }
}

function listTagFor(line) {
  if (/^\s*[-*+]\s+/.test(line)) return 'ul'
  if (/^\s*\d+\.\s+/.test(line)) return 'ol'
  return ''
}

function stripListPrefix(line) {
  return line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
}

function attachHeadingPaths(nodes) {
  const stack = new Array(6).fill('')
  for (const node of nodes) {
    if (node.type === 'heading') {
      stack[node.level - 1] = node.text
      stack.fill('', node.level)
    }
    node.headingPath = stack.filter(Boolean).slice(0, 6)
  }
}

/**
 * Parse editor text into stable source blocks. Lines are one-based.
 * A table row remains an independent source line, so a server page can own
 * several rows while each row can also appear in more than one page fragment.
 */
export function parseSourceDocument(source) {
  const lines = source.split(/\r?\n/)
  const nodes = []
  let i = 0

  while (i < lines.length) {
    const lineNumber = i + 1
    const raw = lines[i]
    const line = raw.trim()

    if (!line) {
      i += 1
      continue
    }

    if (isTableStart(lines, i)) {
      const headers = splitTableRow(lines[i])
      i += 2
      const rows = []
      while (i < lines.length && lines[i].trim().includes('|') && /\|/.test(lines[i].trim())) {
        rows.push({
          line: i + 1,
          cells: splitTableRow(lines[i]),
        })
        i += 1
      }
      const end = rows.length ? rows[rows.length - 1].line : lineNumber
      nodes.push(makeNode('table', lineNumber, end, lines.slice(lineNumber - 1, end).join('\n'), {
        headers,
        rows,
      }))
      continue
    }

    if (/^```/.test(line)) {
      const language = line.slice(3).trim()
      i += 1
      const codeLines = []
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i])
        i += 1
      }
      const end = i
      if (i < lines.length) i += 1
      nodes.push(makeNode('code', lineNumber, end, codeLines.join('\n'), {
        language,
        lineCount: codeLines.length,
        foldable: codeLines.length >= 4,
      }))
      continue
    }

    if (/^#{1,6}\s+/.test(line)) {
      const level = line.match(/^#{1,6}/)[0].length
      const text = line.replace(/^#{1,6}\s+/, '').trim()
      nodes.push(makeNode('heading', lineNumber, lineNumber, text, { level }))
      i += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = []
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i += 1
      }
      nodes.push(makeNode('quote', lineNumber, i, quoteLines.join('\n'), {
        lines: quoteLines,
      }))
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      nodes.push(makeNode('hr', lineNumber, lineNumber, line))
      i += 1
      continue
    }

    const tag = listTagFor(line)
    if (tag) {
      const items = []
      while (i < lines.length && listTagFor(lines[i]) === tag) {
        items.push(stripListPrefix(lines[i].trim()))
        i += 1
      }
      nodes.push(makeNode('list', lineNumber, i, items.join('\n'), { ordered: tag === 'ol', items }))
      continue
    }

    const paragraphLines = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !isTableStart(lines, i) &&
      !/^```/.test(lines[i].trim()) &&
      !/^#{1,6}\s+/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !listTagFor(lines[i])
    ) {
      paragraphLines.push(lines[i].trim())
      i += 1
    }
    nodes.push(makeNode('paragraph', lineNumber, i, paragraphLines.join(' '), {
      images: (paragraphLines.join(' ').match(/!\[[^\]]*\]\(([^)\s]+)/g) || []).length,
    }))
  }

  attachHeadingPaths(nodes)
  return {
    source,
    sourceRevisionHash: stableHash(source),
    totalLines: lines.length,
    nodes,
    nodeAtLine: buildLineIndex(nodes),
    containerTypes: CONTAINER_TYPES,
  }
}

export function buildLineIndex(nodes) {
  const index = new Map()
  for (const node of nodes) {
    for (let line = node.lineStart; line <= node.lineEnd; line += 1) {
      index.set(line, node)
    }
  }
  return index
}

export function sourceNodeAtLine(documentModel, line) {
  return documentModel?.nodeAtLine?.get(line) || null
}
