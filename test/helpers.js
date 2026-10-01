// 测试夹具：确定性的假几何与假滚动侧，不依赖浏览器
import { createGeometry } from '../src/sync/geometry.js'

// 构造一个“线性世界”：源行高由各侧自己的系数决定，锚点天然正确
export function makeFakeSide({ lineHeight = 10, viewport = 100, lines = 100, header = 0, hasMapping = true }) {
  let top = 0
  const anchors = [{ x: 0, y: 0 }]
  for (let s = 1; s <= lines; s += 1) {
    const y = header + (s - 0.5) * lineHeight
    anchors.push({ x: s, y })
  }
  const contentHeight = header + lines * lineHeight + 2
  anchors.push({ x: lines + 0.5, y: contentHeight })

  const geo = createGeometry({
    anchors,
    contentHeight,
    viewportHeight: viewport,
    totalLines: lines,
    hasMapping,
  })

  const sets = []
  const programmaticSets = []
  const side = {
    geo,
    sets,
    programmaticSets,
    getScrollTop: () => top,
    setScrollTop(v, meta = {}) {
      const clamped = Math.max(0, Math.min(v, geo.maxScroll))
      top = clamped
      const entry = { top: clamped, origin: meta.origin || null }
      sets.push(entry)
      if (meta.origin) programmaticSets.push(entry)
    },
  }
  return side
}

// 带“测量偏差”的侧：程序滚动后浏览器真实落点 = 期望值 + bias（模拟图片加载后位移）
export function makeBiasedSide(opts, bias = 0) {
  const side = makeFakeSide(opts)
  const baseSet = side.setScrollTop
  side.setScrollTop = (v, meta = {}) => {
    baseSet(v + bias, meta)
  }
  return side
}

export function makeClock(start = 1000) {
  let t = start
  const timers = []
  const rafs = []
  return {
    now: () => t,
    tick(ms) {
      t += ms
      // 触发到期 timer
      for (let i = timers.length - 1; i >= 0; i -= 1) {
        if (timers[i].at <= t) {
          const [job] = timers.splice(i, 1)
          job.fn()
        }
      }
      // raf 约等于 16ms
      while (rafs.length) {
        const fn = rafs.shift()
        fn()
      }
    },
    setTimeout: (fn, ms) => {
      const id = Symbol('timer')
      timers.push({ id, at: t + ms, fn })
      return id
    },
    clearTimeout: (id) => {
      const idx = timers.findIndex((j) => j.id === id)
      if (idx >= 0) timers.splice(idx, 1)
    },
    raf: (fn) => {
      rafs.push(fn)
      return rafs.length
    },
    caf: () => {},
    advanceRaf() {
      while (rafs.length) rafs.shift()()
    },
  }
}
