// 本地“数据库”：保存布局版本与个人阅读位置。
// 实际生产中这里应替换为 IndexedDB / 服务端 REST；接口保持 Promise 化以便替换。
const POSITION_KEY = 'catalpa.readingPositions.v1'
const LAYOUT_KEY = 'catalpa.layouts.v1'

function safeParse(raw, fallback) {
  if (!raw) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function readMap(key) {
  if (typeof localStorage === 'undefined') return new Map()
  return new Map(Object.entries(safeParse(localStorage.getItem(key), {})))
}

function writeMap(key, map) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(key, JSON.stringify(Object.fromEntries(map)))
}

export function createLocalDb(storage) {
  const ls = storage ?? (typeof localStorage === 'undefined' ? null : localStorage)
  function getItem(k) {
    return ls ? ls.getItem(k) : null
  }
  function setItem(k, v) {
    if (ls) ls.setItem(k, v)
  }

  const positions = new Map(Object.entries(safeParse(getItem(POSITION_KEY), {})))
  const layouts = new Map(Object.entries(safeParse(getItem(LAYOUT_KEY), {})))

  return {
    async savePosition(docId, position) {
      positions.set(docId, position)
      setItem(POSITION_KEY, JSON.stringify(Object.fromEntries(positions)))
    },
    async loadPosition(docId) {
      return positions.get(docId) ?? null
    },
    async saveLayout(docId, layout) {
      layouts.set(docId, layout)
      setItem(LAYOUT_KEY, JSON.stringify(Object.fromEntries(layouts)))
    },
    async loadLayout(docId) {
      return layouts.get(docId) ?? null
    },
    // 测试/调试用：植入一份“旧书签”（旧布局版本 + 旧滚动位置）
    async seedPosition(docId, position) {
      return this.savePosition(docId, position)
    },
    _maps: { positions, layouts },
  }
}
