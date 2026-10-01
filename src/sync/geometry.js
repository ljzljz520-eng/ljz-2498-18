// 实时浏览器测量 → 稳定锚点。
// 锚点统一以“源行坐标 s”为中间语言：
//   编辑器侧每一行一个锚点；预览侧每个渲染块（或拆表分片）一个锚点。
// 配合 linear.js 的分段线性映射，支持：
//   - 一个源表格跨多页（多个分片落在不同 y）
//   - 一个预览段落由多个源行组成（宽区间锚点）
import { buildLinearMapper, buildInverseMapper } from './linear.js'

// lineTops: [{ top, height }]，按源行顺序（含因折叠而缺失的行）
export function buildEditorAnchors(lineTops) {
  const points = [{ x: 0, y: 0 }]
  lineTops.forEach((item, index) => {
    if (!item) return
    points.push({ x: index + 1, y: item.top + item.height / 2 })
  })
  const last = lineTops.length + 1
  const lastTop = lineTops.filter(Boolean).slice(-1)[0]
  points.push({ x: last, y: lastTop ? lastTop.top + lastTop.height + 4 : 0 })
  return points.sort((a, b) => a.x - b.x)
}

// measuredBlocks: [{ blockId, startLine, endLine, top, height }]
// layoutFragments: 后端分片（表格按 part 切分）；为空时整块一个锚点
export function buildPreviewAnchors(measuredBlocks, layoutFragments = []) {
  const points = [{ x: 0, y: 0 }]
  if (!measuredBlocks.length) return points

  const fragmentsByBlock = new Map()
  for (const f of layoutFragments) {
    const list = fragmentsByBlock.get(f.blockId) || []
    list.push(f)
    fragmentsByBlock.set(f.blockId, list)
  }

  for (const block of measuredBlocks) {
    const frags = (fragmentsByBlock.get(block.blockId) || [])
      .slice()
      .sort((a, b) => a.part.index - b.part.index)

    if (frags.length <= 1) {
      points.push({
        x: (block.startLine + block.endLine) / 2,
        y: block.top + block.height / 2,
      })
      continue
    }

    // 跨页/多分片：按后端给出的各分片高度比例切分实测块高度
    const totalServer = frags.reduce((sum, f) => sum + f.height, 0) || block.height
    let offset = 0
    frags.forEach((f) => {
      const h = (f.height / totalServer) * block.height
      const s = (f.startLine + f.endLine) / 2
      const y = block.top + offset + h / 2
      points.push({ x: s, y })
      offset += h
    })
  }

  const lastBlock = measuredBlocks[measuredBlocks.length - 1]
  points.push({
    x: lastBlock.endLine + 0.5,
    y: lastBlock.top + lastBlock.height + 8,
  })
  return points.sort((a, b) => a.x - b.x)
}

// 由锚点构造双侧几何对象
export function createGeometry({ anchors, contentHeight, viewportHeight, totalLines, hasMapping = true }) {
  const forward = buildLinearMapper(anchors) // 源行 → 该侧 y
  const inverse = buildInverseMapper(anchors) // 该侧 y → 源行
  const maxScroll = Math.max(0, contentHeight - viewportHeight)

  return {
    hasMapping,
    totalLines,
    contentHeight,
    viewportHeight,
    maxScroll,
    sToY(s) {
      const y = forward.map(s)
      return y == null ? null : clamp(y, 0, contentHeight)
    },
    yToS(y) {
      return inverse.map(clamp(y, 0, contentHeight))
    },
    // 无映射时的百分比降级使用
    ratioToY(ratio) {
      return clamp(ratio * maxScroll, 0, maxScroll)
    },
    yToRatio(y) {
      return maxScroll <= 0 ? 0 : clamp(y / maxScroll, 0, 1)
    },
  }
}

// 百分比硬同步的线性锚点（无映射降级时使用，已隔离在映射体系之外）
export function createRatioGeometry({ contentHeight, viewportHeight, totalLines }) {
  return createGeometry({
    anchors: [
      { x: 0, y: 0 },
      { x: totalLines + 0.5, y: Math.max(contentHeight, viewportHeight) },
    ],
    contentHeight: Math.max(contentHeight, viewportHeight),
    viewportHeight,
    totalLines,
    hasMapping: false,
  })
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
