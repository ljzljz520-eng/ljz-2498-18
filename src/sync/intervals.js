// 区间工具：源行区间统一采用 [startLine, endLine] 的 1-based 闭区间
// （0 行表示文档顶部之前的虚拟锚点）。

export function rangeKey(startLine, endLine) {
  return `${startLine}-${endLine}`
}

export function mergeRanges(ranges) {
  const sorted = ranges
    .map((r) => ({ startLine: r.startLine, endLine: r.endLine }))
    .filter((r) => Number.isFinite(r.startLine) && Number.isFinite(r.endLine))
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)

  const merged = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, range.endLine)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

// 判断区间是否重叠或相接
export function rangesOverlap(a, b) {
  return a.startLine <= b.endLine && b.startLine <= a.endLine
}

// 覆盖指定行的所有区间（用于“长表跨页”：一个源行被多个布局分片覆盖）
export function rangesCoveringLine(ranges, line) {
  return ranges
    .filter((r) => line >= r.startLine && line <= r.endLine)
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
}
