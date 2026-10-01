// 分段线性映射器：以“稳定锚点” (x, y) 序列建立双向映射。
// 这是“不能用两个容器百分比硬同步”的核心：编辑器/预览的高度分布并不一致，
// 只有锚点之间的局部插值才能在任意位置给出正确结果。

export function buildLinearMapper(points, options = {}) {
  const { extrapolate = false } = options
  const pts = points
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: p.x, y: p.y }))
    .sort((a, b) => a.x - b.x)

  // 同 x 去重（保留第一个）
  const unique = []
  for (const p of pts) {
    if (!unique.length || unique[unique.length - 1].x !== p.x) {
      unique.push(p)
    }
  }

  function map(value) {
    if (!unique.length) return null
    if (value <= unique[0].x) {
      if (!extrapolate) return unique[0].y
      const a = unique[0]
      const b = unique[1] || a
      const span = b.x - a.x || 1
      return a.y + ((value - a.x) / span) * (b.y - a.y)
    }
    for (let i = 0; i < unique.length - 1; i += 1) {
      const a = unique[i]
      const b = unique[i + 1]
      if (value >= a.x && value <= b.x) {
        const span = b.x - a.x
        if (span === 0) return a.y
        const t = (value - a.x) / span
        return a.y + t * (b.y - a.y)
      }
    }
    const last = unique[unique.length - 1]
    if (!extrapolate) return last.y
    const prev = unique[unique.length - 2] || last
    const span = last.x - prev.x || 1
    return last.y + ((value - last.x) / span) * (last.y - prev.y)
  }

  return { map, points: unique }
}

// 反函数：交换 x/y 后重新构建（y 可能相等，交由去重处理）
export function buildInverseMapper(points, options = {}) {
  return buildLinearMapper(points.map((p) => ({ x: p.y, y: p.x })), options)
}
