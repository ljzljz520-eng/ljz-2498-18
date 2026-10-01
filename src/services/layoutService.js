// 模拟“渲染后端”的排版服务：
//  - 输入文档内容，返回布局版本号 + 布局节点 → 源节点的映射分片
//  - 一个源表格会被拆成跨页的多个布局分片（fragments）
//  - 任意块若超出单页剩余高度都会续页（many-to-many）
//  - 网络层支持乱序回包与请求失败，由上层 MappingClient 做版本裁决
import { parseCatalpaBlocks } from '../utils/catalpa.js'
import { fnv1a } from '../utils/hash.js'

export const PAGE_HEIGHT = 760 // 模拟版芯高度（px）

function estimateBlockHeight(block) {
  switch (block.type) {
    case 'heading':
      return 44 + (7 - block.level) * 6
    case 'hr':
      return 28
    case 'quote':
      return Math.max(48, block.lines.length * 30 + 24)
    case 'list':
      return block.items.length * 32 + 16
    case 'code':
      return block.code.split('\n').length * 20 + 56
    case 'table':
      return (block.rows.length + 1) * 34 + 24
    case 'paragraph':
      return Math.max(34, Math.ceil(block.lines.join(' ').length / 42) * 30 + 16)
    default:
      return 40
  }
}

// 把一个块按版芯流式切分到若干页。
// units 为“最小排版单位”的高度序列（表格按行，其它块为整块或等高切片）。
function flowBlock({ block, units, headerUnits = 0, cursor }) {
  const fragments = []
  let page = cursor.page
  let used = cursor.used
  let unitIndex = 0
  let consumed = 0 // 当前分片已消耗的单位高度
  let headerLeft = headerUnits

  const startLineFor = (idx) => {
    if (block.type !== 'table') return block.startLine
    // 表格：表头占前两行源行，数据行从第 3 行开始
    return idx === 0 ? block.startLine : Math.min(block.startLine + 2 + idx, block.endLine)
  }

  while (unitIndex < units.length) {
    const top = used
    let h = 0
    const firstUnit = unitIndex
    if (headerLeft > 0) {
      h += headerLeft
      headerLeft = 0
    }
    while (unitIndex < units.length) {
      const u = units[unitIndex]
      if (h + u > PAGE_HEIGHT - top && h > 0) break
      h += u
      unitIndex += 1
    }
    // 单个单位比整页还高：硬切
    if (h === 0) {
      h = Math.min(units[unitIndex], PAGE_HEIGHT - top)
      units[unitIndex] -= h
      if (units[unitIndex] <= 0) unitIndex += 1
    }
    const index = fragments.length
    fragments.push({
      id: index === 0 ? block.id : `${block.id}-p${index}`,
      blockId: block.id,
      type: block.type,
      page,
      top,
      height: h,
      startLine: startLineFor(firstUnit),
      endLine: block.endLine,
      part: { index, of: -1 },
      signature: fnv1a(`${block.type}:${block.id}:${firstUnit}`),
      ordinal: block.startLine * 1000 + firstUnit,
      consumedUnits: consumed,
    })
    consumed += h
    used = top + h
    if (unitIndex < units.length) {
      page += 1
      used = 0
    }
  }

  const of = fragments.length
  fragments.forEach((f) => { f.part.of = of })
  return { fragments, cursor: { page, used } }
}

// 计算一份文档的完整布局索引
export function computeLayout(source) {
  const blocks = parseCatalpaBlocks(source)
  let fragments = []
  let cursor = { page: 1, used: 0 }

  for (const block of blocks) {
    let result
    if (block.type === 'table') {
      // 表头 58px（含表头等），每行 34px
      const units = block.rows.map(() => 34)
      result = flowBlock({ block, units, headerUnits: 58, cursor })
    } else {
      result = flowBlock({ block, units: [estimateBlockHeight(block)], cursor })
    }
    fragments.push(...result.fragments)
    cursor = result.cursor
  }

  // 去掉内部字段
  fragments = fragments.map(({ consumedUnits, ...f }) => f)
  const pageCount = cursor.used > 0 ? cursor.page : Math.max(1, cursor.page - 1)
  return {
    version: `lay_${fnv1a(source)}`,
    sourceSignature: fnv1a(source),
    pageHeight: PAGE_HEIGHT,
    pageCount,
    fragments,
  }
}

// —— 模拟网络服务 ——
let requestSeq = 0

export function createLayoutService(options = {}) {
  const {
    latencyMin = 60,
    latencyMax = 260,
    rng = Math.random,
  } = options

  const state = { failureOnce: false, mode: 'normal' }

  function requestLayout({ docId, source }) {
    const reqId = ++requestSeq
    const latency = latencyMin + rng() * (latencyMax - latencyMin)
    const shouldFail = state.failureOnce
    state.failureOnce = false

    return new Promise((resolve, reject) => {
      const delay = state.mode === 'out-of-order' && rng() < 0.4 ? latency * 0.15 : latency
      setTimeout(() => {
        if (shouldFail) {
          reject(new Error(`layout service 503 for ${docId} (req ${reqId})`))
          return
        }
        resolve({ reqId, docId, ...computeLayout(source) })
      }, delay)
    })
  }

  return {
    requestLayout,
    setMode(mode) { state.mode = mode },
    failNext() { state.failureOnce = true },
  }
}
