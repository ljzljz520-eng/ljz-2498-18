export const SYNC_EPSILON_PX = 2

export function clamp(value, min, max) {
  if (min > max) return min
  return Math.min(max, Math.max(min, value))
}

export function emptyMappingBundle() {
  return {
    layoutVersion: '',
    sourceRevisionHash: '',
    page: null,
    layoutNodes: [],
    sourceRanges: [],
    degraded: true,
  }
}

function byPosition(a, b) {
  return a.y - b.y || a.sourceLineStart - b.sourceLineStart
}

function getRanges(bundle) {
  return [...(bundle?.sourceRanges || [])].sort(byPosition)
}

function sourceNodeMap(model) {
  const map = new Map()
  for (const node of model?.nodes || []) map.set(node.id, node)
  return map
}

function findSourceNode(model, anchor) {
  if (!model) return null
  const byId = model.nodes.find((node) =>
    node.id === anchor.sourceNodeId || node.fingerprint === anchor.sourceNodeFingerprint)
  if (byId) return byId
  const byLine = Number.isInteger(anchor.sourceLine) ? sourceNodeAtLine(model, anchor.sourceLine) : null
  if (byLine) return byLine
  if (anchor.headingPath?.length) {
    return model.nodes.find((node) =>
      node.type === 'heading' &&
      node.headingPath?.join('/') === anchor.headingPath.join('/')) || null
  }
  return null
}

export function sourceNodeAtLine(model, line) {
  return model?.nodeAtLine?.get(line) || null
}

function candidateRangesForAnchor(ranges, node, anchor) {
  const own = ranges.filter((range) =>
    range.sourceNodeId === node.id || range.sourceNodeFingerprint === node.fingerprint)
  if (!own.length) return []
  if (Number.isInteger(anchor.sourceLine)) {
    const exact = own.filter((range) =>
      anchor.sourceLine >= range.sourceLineStart && anchor.sourceLine <= range.sourceLineEnd)
    if (exact.length) return exact
  }
  const ratio = clamp(Number(anchor.nodeRatio ?? anchor.ratio ?? 0), 0, 1)
  const before = own.filter((range) => range.ratio <= ratio)
  return before.length ? [before[before.length - 1]] : [own[0]]
}

function ratioInRange(range, anchor) {
  const inline = clamp(Number(anchor.lineRatio ?? 0), 0, 1)
  if (!Number.isInteger(anchor.sourceLine)) {
    return clamp(Number(anchor.nodeRatio ?? anchor.ratio ?? 0), 0, 1)
  }
  if (range.sourceLineStart === range.sourceLineEnd) {
    return anchor.sourceLine === range.sourceLineStart ? inline : 0
  }
  const span = range.sourceLineEnd - range.sourceLineStart + 1
  return clamp((anchor.sourceLine - range.sourceLineStart + inline) / span, 0, 1)
}

function measuredLayoutY(bundle, serverY, measurements = new Map(), preferredId = '') {
  if (preferredId && measurements.has(preferredId)) {
    const measuredNode = measurements.get(preferredId)
    const serverNode = bundle.layoutNodes.find((node) => node.id === preferredId)
    if (serverNode && serverNode.height > 0) {
      return measuredNode.y + clamp((serverY - serverNode.y) / serverNode.height, 0, 1) * measuredNode.height
    }
    return measuredNode.y
  }

  const direct = [...measurements.values()]
    .filter((item) => serverY >= item.y && serverY <= item.y + item.height)
    .sort((a, b) => (b.height - a.height) || (a.y - b.y))[0]
  if (direct) {
    const serverNode = bundle.layoutNodes.find((node) => node.id === direct.id)
    if (serverNode && serverNode.height > 0) {
      return direct.y + clamp((serverY - serverNode.y) / serverNode.height, 0, 1) * direct.height
    }
    return direct.y
  }

  const sorted = [...measurements.values()].sort((a, b) => a.y - b.y)
  const previous = [...sorted].reverse().find((item) => item.y <= serverY)
  const next = sorted.find((item) => item.y + item.height >= serverY)
  if (previous && next && next.y !== previous.y) {
    const prevServer = bundle.layoutNodes.find((node) => node.id === previous.id)
    const nextServer = bundle.layoutNodes.find((node) => node.id === next.id)
    if (prevServer && nextServer) {
      const t = (serverY - prevServer.y) / Math.max(1, nextServer.y + nextServer.height - prevServer.y)
      return previous.y + t * (next.y + next.height - previous.y)
    }
  }
  if (previous) {
    const serverNode = bundle.layoutNodes.find((node) => node.id === previous.id)
    const delta = previous.y - (serverNode?.y ?? previous.y)
    return serverY + delta
  }
  return serverY
}

function serverLayoutY(bundle, measuredY, measurements) {
  const direct = [...measurements.values()]
    .filter((item) => measuredY >= item.y && measuredY <= item.y + item.height)
    .sort((a, b) => (b.height - a.height) || (a.y - b.y))[0]
  if (direct) {
    const serverNode = bundle.layoutNodes.find((node) => node.id === direct.id)
    if (serverNode && direct.height > 0) {
      return serverNode.y + clamp((measuredY - direct.y) / direct.height, 0, 1) * serverNode.height
    }
  }
  const sorted = [...measurements.values()].sort((a, b) => a.y - b.y)
  const previous = [...sorted].reverse().find((item) => item.y <= measuredY)
  if (previous) {
    const serverNode = bundle.layoutNodes.find((node) => node.id === previous.id)
    if (serverNode) return measuredY + serverNode.y - previous.y
  }
  return measuredY
}

/**
 * Convert a stable source anchor to preview viewport-independent content Y.
 * Measurements are real DOM rects; server indexes are only the initial map.
 */
export function sourceAnchorToLayout(bundle, model, anchor, measurements = new Map()) {
  if (!bundle?.sourceRanges?.length || !model) {
    return { y: null, confidence: 'none', reason: 'no-mapping' }
  }
  const node = findSourceNode(model, anchor)
  if (!node) {
    return { y: null, confidence: 'none', reason: 'source-anchor-missing' }
  }
  const ranges = getRanges(bundle)
  const candidates = candidateRangesForAnchor(ranges, node, anchor)
  if (!candidates.length) {
    return { y: null, confidence: 'none', reason: 'layout-range-missing' }
  }
  const range = candidates[0]
  const ratio = ratioInRange(range, anchor)
  const serverY = range.y + range.height * ratio
  const y = measuredLayoutY(bundle, serverY, measurements, range.layoutNodeId)
  const measuredNode = [...measurements.values()]
    .find((item) => item.id === range.layoutNodeId)
  const drift = measuredNode ? y - serverY : 0
  const exact = range.sourceNodeFingerprint === node.fingerprint &&
    anchor.sourceLine >= range.sourceLineStart &&
    anchor.sourceLine <= range.sourceLineEnd
  return {
    y,
    serverY,
    drift,
    range,
    confidence: exact ? (Math.abs(drift) > 8 ? 'drift-corrected' : 'exact') : 'interpolated',
  }
}

function rangeForLayoutPosition(ranges, serverY) {
  const containing = ranges.find((range) => serverY >= range.y && serverY < range.y + range.height)
  if (containing) return { range: containing, ratio: (serverY - containing.y) / Math.max(1, containing.height) }
  const sorted = [...ranges].sort(byPosition)
  if (serverY <= sorted[0].y) return { range: sorted[0], ratio: 0 }
  return { range: sorted[sorted.length - 1], ratio: 1 }
}

/** Convert current preview content Y to a stable source anchor. */
export function layoutPositionToSource(bundle, measuredY, measurements = new Map()) {
  if (!bundle?.sourceRanges?.length) {
    return { anchor: null, confidence: 'none', reason: 'no-mapping' }
  }
  const ranges = getRanges(bundle)
  const serverY = serverLayoutY(bundle, measuredY, measurements)
  const { range, ratio } = rangeForLayoutPosition(ranges, serverY)
  const span = range.sourceLineEnd - range.sourceLineStart + 1
  const sourceLine = clamp(
    Math.floor(range.sourceLineStart + ratio * span - 0.0001),
    range.sourceLineStart,
    range.sourceLineEnd,
  )
  const lineRatio = ratio * span - (sourceLine - range.sourceLineStart)
  return {
    anchor: {
      sourceNodeId: range.sourceNodeId,
      sourceNodeFingerprint: range.sourceNodeFingerprint,
      sourceLine,
      lineRatio: clamp(lineRatio, 0, 1),
      nodeRatio: clamp((sourceLine - range.sourceLineStart + lineRatio) /
        Math.max(1, range.sourceLineEnd - range.sourceLineStart + 1), 0, 1),
      headingPath: range.headingPath,
    },
    range,
    confidence: measurements.size ? 'measured' : 'server-index',
  }
}

/**
 * Re-resolve an old bookmark after edits, layout version changes or document
 * reload. Fingerprint is preferred because line numbers shift while editing.
 */
export function resolveBookmark(model, bookmark) {
  if (!model || !bookmark) return { anchor: null, status: 'missing' }
  const node = findSourceNode(model, bookmark)
  if (!node) {
    return {
      anchor: { sourceLine: 1, lineRatio: 0, nodeRatio: 0 },
      status: 'document-changed-top',
    }
  }
  const requestedLine = Number.isInteger(bookmark.sourceLine) ? bookmark.sourceLine : null
  const sourceLine = clamp(
    requestedLine ?? node.lineStart,
    node.lineStart,
    node.lineEnd,
  )
  const exact = node.fingerprint === bookmark.sourceNodeFingerprint &&
    (requestedLine === null || (requestedLine >= node.lineStart && requestedLine <= node.lineEnd))
  return {
    anchor: {
      sourceNodeId: node.id,
      sourceNodeFingerprint: node.fingerprint,
      sourceLine,
      lineRatio: clamp(bookmark.lineRatio ?? 0, 0, 1),
      nodeRatio: clamp(bookmark.nodeRatio ??
        (sourceLine - node.lineStart) / Math.max(1, node.lineEnd - node.lineStart), 0, 1),
      headingPath: node.headingPath,
    },
    sourceNode: node,
    status: exact ? 'exact' : 'fingerprint-repaired',
  }
}

export function bookmarkFromSourceAnchor(anchor, extra = {}) {
  return {
    sourceNodeId: anchor.sourceNodeId,
    sourceNodeFingerprint: anchor.sourceNodeFingerprint,
    sourceLine: anchor.sourceLine,
    lineRatio: anchor.lineRatio ?? 0,
    nodeRatio: anchor.nodeRatio ?? 0,
    headingPath: anchor.headingPath || [],
    ...extra,
  }
}

export function serializePosition(position) {
  return JSON.stringify(position)
}

export function deserializePosition(text) {
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object') return null
    return value
  } catch {
    // Old clients may have stored a raw scroll percentage. Never trust it as
    // an identity-based bookmark; callers will restore top and save a repair.
    return null
  }
}
