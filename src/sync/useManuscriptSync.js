// 文稿台位置同步：Vue 组合式接入层。
// 编排：编辑器镜像测量 / 预览 DOM 实测 / 排版映射请求 / 同步引擎 / 书签持久化
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { renderCatalpa, parseCatalpaBlocks } from '../utils/catalpa.js'
import { fnv1a } from '../utils/hash.js'
import { createEditorMirror } from './editorMirror.js'
import { buildEditorAnchors, buildPreviewAnchors, createGeometry } from './geometry.js'
import { createMappingClient } from './mappingClient.js'
import { createScrollSyncEngine } from './scrollSyncEngine.js'
import { createPositionSaver } from './positionSaver.js'
import { createBookmark, restoreBookmark, anchorForS } from './bookmark.js'
import { createLayoutService } from '../services/layoutService.js'
import { createLocalDb } from '../services/localDb.js'

export function useManuscriptSync(docs, injected = {}) {
  const currentDocId = ref(docs.value[0]?.id ?? '')
  const locked = ref(true)
  const mode = ref('mapping') // mapping | ratio(无映射降级)
  const status = ref('初始化…')
  const syncStats = shallowRef({ corrections: 0, requests: 0, stale: 0, errors: 0 })

  const editorEl = ref(null)
  const previewEl = ref(null)

  const db = injected.db || createLocalDb()
  const service = injected.service || createLayoutService()
  const mapping = injected.mapping || createMappingClient(service)
  const saver = createPositionSaver(db, { delay: 350 })

  let mirror = null
  let engine = null
  const layout = shallowRef(null)
  let contentSignature = ''
  let totalLines = 0
    let foldedRanges = []
  let restoring = false
  let observers = []
  let lastMapKey = ''
  const stats = { corrections: 0, requests: 0, stale: 0, errors: 0 }

  const currentDoc = computed(() => docs.value.find((d) => d.id === currentDocId.value) || docs.value[0])
  const previewHtml = computed(() => renderCatalpa(currentDoc.value?.source ?? ''))

  function setStatus(text) {
    status.value = text
  }

  function bumpStats(patch) {
    Object.assign(stats, patch)
    syncStats.value = { ...stats }
  }

  // —— 几何测量 ——

  function refreshEditorGeometry() {
    const el = editorEl.value
    if (!el || !mirror) return null
    const { lineTops, contentHeight } = mirror.measure(currentDoc.value.source)
    // 折叠代码后：被折叠行无测量值，锚点由剩余行线性覆盖
    const anchors = buildEditorAnchors(lineTops)
    const geo = createGeometry({
      anchors,
      contentHeight: Math.max(contentHeight, el.clientHeight),
      viewportHeight: el.clientHeight,
      totalLines,
      hasMapping: true,
    })
    engine?.setGeometry('editor', geo)
    return geo
  }

  function measurePreviewBlocks() {
    const root = previewEl.value
    if (!root) return []
    const nodes = Array.from(root.querySelectorAll('.src-block'))
    return nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      return {
        blockId: node.dataset.blockId,
        startLine: Number(node.dataset.startLine),
        endLine: Number(node.dataset.endLine),
        top: rect.top - rootRect.top + root.scrollTop,
        height: rect.height,
      }
    })
  }

  function refreshPreviewGeometry() {
    const el = previewEl.value
    if (!el) return null
    const measured = measurePreviewBlocks()
    const hasLayout = !!layout.value
    const anchors = buildPreviewAnchors(measured, layout.value?.fragments || [])
    const geo = createGeometry({
      anchors,
      contentHeight: Math.max(el.scrollHeight, el.clientHeight),
      viewportHeight: el.clientHeight,
      totalLines,
      hasMapping: hasLayout,
    })
    engine?.setGeometry('preview', geo)
    return geo
  }

  // —— 映射请求（带乱序裁决） ——

  let mapToken = 0

  async function requestMapping(reason) {
    const docId = currentDocId.value
    const source = currentDoc.value.source
    const sig = fnv1a(source)
    const key = `${docId}:${sig}`
    if (key === lastMapKey && layout.value) return
    lastMapKey = key
    const myToken = ++mapToken
    bumpStats({ requests: stats.requests + 1 })
    setStatus('请求排版映射…')

    const result = await mapping.request(docId, source)
    // 回包乱序 / 用户已切换文稿：mapping client 已裁决 reqId，再校验 token 与 docId
    if (myToken !== mapToken || docId !== currentDocId.value || sig !== fnv1a(currentDoc.value.source)) {
      bumpStats({ stale: stats.stale + 1 })
      setStatus('已丢弃过期映射回包')
      return
    }

    if (result.status === 'stale') {
      bumpStats({ stale: stats.stale + 1 })
      return
    }
    if (result.status === 'error') {
      bumpStats({ errors: stats.errors + 1 })
      const cached = mapping.getCached(docId) || await db.loadLayout(docId)
      if (cached) {
        layout.value = cached
        setStatus('映射请求失败，使用已保存布局版本')
      } else {
        layout.value = null
        engine?.setMode('ratio')
        mode.value = 'ratio'
        setStatus('映射不可用，已降级为比例同步')
      }
    } else {
      layout.value = result.layout
      db.saveLayout(docId, result.layout)
      engine?.setMode('mapping')
      mode.value = 'mapping'
      setStatus(`映射就绪 v${result.layout.version.slice(-6)}（${result.layout.pageCount} 页）`)
    }
    refreshPreviewGeometry()
    engine?.relayout(`mapping-${reason}`)
  }

  // —— 书签保存 ——

  function persistNow() {
    const doc = currentDoc.value
    if (!doc || !engine) return
    const geoE = engine.getState()
    const editorTop = editorEl.value?.scrollTop ?? 0
    const previewTop = previewEl.value?.scrollTop ?? 0
    const s = geoE.lastS.editor
    const anchor = anchorForS(layout.value?.fragments || [], s)
    const bookmark = createBookmark({
      docId: doc.id,
      layoutVersion: layout.value?.version ?? 'none',
      sourceSignature: contentSignature,
      totalLines,
      editorScrollTop: editorTop,
      previewScrollTop: previewTop,
      anchor,
    })
    saver.scheduleSave(doc.id, contentSignature, bookmark)
  }

  // —— 文档装载 / 书签恢复 ——

  async function loadDocument(docId, { fromSwitch = false } = {}) {
    if (fromSwitch) {
      // 切走前把旧文稿待写位置冲刷到它自己的记录（不允许写到新文稿）
      const oldDoc = docs.value.find((d) => d.id === currentDocId.value)
      if (oldDoc) {
        const editorTop = editorEl.value?.scrollTop ?? 0
        const previewTop = previewEl.value?.scrollTop ?? 0
        const anchor = anchorForS(layout.value?.fragments || [], engine?.getState().lastS.editor ?? 0)
        saver.flushNow(oldDoc.id, contentSignature, createBookmark({
          docId: oldDoc.id,
          layoutVersion: layout.value?.version ?? 'none',
          sourceSignature: contentSignature,
          totalLines,
          editorScrollTop: editorTop,
          previewScrollTop: previewTop,
          anchor,
        }))
        saver.endSession(oldDoc.id)
      }
    }

    currentDocId.value = docId
    mapToken += 1 // 作废在途映射回包
    mapping.invalidate()
    lastMapKey = ''
    layout.value = null
    foldedRanges = []

    const doc = currentDoc.value
    contentSignature = fnv1a(doc.source)
    totalLines = doc.source.split('\n').length
    saver.beginSession(doc.id, contentSignature)

    // 历史布局缓存（服务请求未回前先用已保存版本粗对齐）
    const savedLayout = await db.loadLayout(doc.id)
    if (savedLayout && currentDocId.value === docId && savedLayout.sourceSignature === contentSignature) {
      layout.value = savedLayout
      mapping.hydrate(doc.id, savedLayout)
    }

    // DOM 更新后测量几何（DOM 在 nextTick 更新后）
    await nextTickPromise()
    engine?.setMode(layout.value ? 'mapping' : 'ratio')
    mode.value = layout.value ? 'mapping' : 'ratio'
    refreshEditorGeometry()
    refreshPreviewGeometry()

    // 恢复个人阅读位置（可能是旧书签 → 迁移）
    const savedPosition = await db.loadPosition(doc.id)
    let restored = null
    if (savedPosition) {
      restored = restoreBookmark({
        bookmark: savedPosition,
        fragments: layout.value?.fragments || [],
        currentLayoutVersion: layout.value?.version ?? 'none',
        currentSourceSignature: contentSignature,
        currentTotalLines: totalLines,
      })
    }

    restoring = true
    if (restored) {
      if (!restored.migrated && restored.editorScrollTop != null) {
        engine.restoreAt({ side: 'editor', scrollTop: restored.editorScrollTop, s: restored.s, verify: false })
        setStatus('已恢复阅读位置')
      } else if (restored.s != null) {
        engine.restoreAt({ side: 'editor', s: restored.s, verify: true })
        setStatus('已按新布局迁移旧书签')
      }
    }
    restoring = false

    // 向服务端请求最新布局版本；回包后 requestMapping 会再次测量并重定位
    requestMapping('load')
  }

  // —— 折叠 ——

  function onBlockClick(event) {
    const target = event.target instanceof Element ? event.target : null
    const toggle = target?.closest?.('.fold-toggle')
    if (!toggle) return
    const wrap = toggle.closest('.code-block')
    const srcBlock = wrap?.closest('.src-block')
    if (!srcBlock) return
    const pre = wrap.querySelector('pre')
    const collapsed = pre.classList.toggle('collapsed')
    toggle.setAttribute('aria-expanded', String(!collapsed))
    toggle.textContent = collapsed ? '展开代码' : '折叠代码'

    const blockId = srcBlock.dataset.blockId
    if (collapsed) {
      if (!foldedRanges.includes(blockId)) foldedRanges = [...foldedRanges, blockId]
    } else {
      foldedRanges = foldedRanges.filter((id) => id !== blockId)
    }
    // 折叠动画/高度变化后重定位
    requestAnimationFrame(() => {
      refreshEditorGeometry()
      refreshPreviewGeometry()
      engine.relayout('code-fold')
    })
  }

  // —— 监听器：图片加载/失败、字体替换、窗口缩放、DOM 变化 ——

  function scheduleRelayout(reason) {
    requestAnimationFrame(() => {
      refreshEditorGeometry()
      refreshPreviewGeometry()
      engine?.relayout(reason)
    })
  }

  function bindObservers() {
    const root = previewEl.value

    // scroll 事件在 scrollTop 赋值时同步派发；捕获阶段读取程序滚动令牌并贴到事件上
    const onScrollCapture = (side) => (event) => {
      if (pendingOrigins[side]) {
        Object.defineProperty(event, '__origin', {
          value: pendingOrigins[side],
          configurable: true,
        })
        pendingOrigins[side] = null
      }
    }
    const onScroll = (side) => (event) => {
      engine.handleScroll(side, { origin: event.__origin || null })
    }
    editorEl.value.addEventListener('scroll', onScrollCapture('editor'), true)
    root.addEventListener('scroll', onScrollCapture('preview'), true)
    editorEl.value.addEventListener('scroll', onScroll('editor'), { passive: true })
    root.addEventListener('scroll', onScroll('preview'), { passive: true })

    // 图片加载完成或懒加载失败都重定位（失败也要：占位高度改变）
    const onImg = (event) => {
      scheduleRelayout(event.type === 'error' ? 'img-error' : 'img-load')
    }
    root.addEventListener('load', onImg, true)
    root.addEventListener('error', onImg, true)

    // 折叠点击
    root.addEventListener('click', onBlockClick)

    // 窗口缩放
    let resizeTimer = 0
    const onResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => scheduleRelayout('window-resize'), 120)
    }
    window.addEventListener('resize', onResize)

    // 字体替换完成后重定位
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => scheduleRelayout('font-ready')).catch(() => {})
    }
    if (document.fonts && 'onloadingdone' in document.fonts) {
      // FontFaceSet 事件
      try {
        document.fonts.addEventListener('loadingdone', () => scheduleRelayout('font-swap'))
      } catch {
        /* noop */
      }
    }

    // 预览 DOM 变化（内容编辑导致渲染更新）
    const mo = new MutationObserver(() => scheduleRelayout('dom-mutation'))
    mo.observe(root, { childList: true, subtree: true, characterData: true })

    // 编辑器字号/布局变化（ResizeObserver 覆盖宽度变化导致的折行改变）
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => scheduleRelayout('editor-resize'))
      ro.observe(editorEl.value)
      observers.push(() => ro.disconnect())
    }

    observers.push(() => {
      editorEl.value?.removeEventListener('scroll', onScrollCapture('editor'), true)
      root.removeEventListener('scroll', onScrollCapture('preview'), true)
      editorEl.value?.removeEventListener('scroll', onScroll('editor'))
      root.removeEventListener('scroll', onScroll('preview'))
      root.removeEventListener('load', onImg, true)
      root.removeEventListener('error', onImg, true)
      root.removeEventListener('click', onBlockClick)
      window.removeEventListener('resize', onResize)
      mo.disconnect()
      clearTimeout(resizeTimer)
    })
  }

  function nextTickPromise() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }

  // —— 生命周期 ——

  // 程序滚动令牌：必须在“赋值 scrollTop 之前”放入，因为 scroll 事件同步派发
  const pendingOrigins = { editor: null, preview: null }
  function programmaticScroll(side, top, origin) {
    const el = side === 'editor' ? editorEl.value : previewEl.value
    if (!el) return
    pendingOrigins[side] = origin
    try {
      el.scrollTop = top
    } finally {
      // 若赋值未实际触发 scroll（位置无变化），下一微任务清掉令牌，避免误伤用户滚动
      Promise.resolve().then(() => {
        if (pendingOrigins[side] === origin) pendingOrigins[side] = null
      })
    }
  }

  function mount() {
    mirror = createEditorMirror(editorEl.value)
    engine = createScrollSyncEngine({
      // resolver 形式：几何/容器在图片加载、折叠、缩放后会“换底”，
      // 引擎每次通过函数取当前 DOM 侧，避免持有过期对象
      sides: {
        editor: () => ({
          getScrollTop: () => editorEl.value?.scrollTop ?? 0,
          setScrollTop: (top, meta) => programmaticScroll('editor', top, meta?.origin),
        }),
        preview: () => ({
          getScrollTop: () => previewEl.value?.scrollTop ?? 0,
          setScrollTop: (top, meta) => programmaticScroll('preview', top, meta?.origin),
        }),
      },
      lock: locked.value,
      onPersist: () => {
        if (!restoring) persistNow()
      },
      onEvent: (evt) => {
        if (evt.type === 'watchdog-halt') setStatus('检测到异常滚动振荡，已暂停同步')
      },
    })

    bindObservers()
    loadDocument(currentDocId.value)
  }

  function toggleLock() {
    locked.value = !locked.value
    engine?.setLock(locked.value)
    setStatus(locked.value ? '已锁定：双向跟随' : '已解锁：两侧各自滚动并保留位置')
  }

  async function switchDoc(docId) {
    if (docId === currentDocId.value) return
    await loadDocument(docId, { fromSwitch: true })
  }

  // 内容编辑：防抖重新请求映射并触发重定位
  let editTimer = 0
  watch(
    () => currentDoc.value.source,
    (next, prev) => {
      if (next === prev) return
      clearTimeout(editTimer)
      contentSignature = fnv1a(next)
      totalLines = next.split('\n').length
      foldedRanges = []
      // 内容变化后以新签名开启保存会话（旧签名的待写计时器已自然失效）
      saver.endSession(currentDocId.value)
      saver.beginSession(currentDocId.value, contentSignature)
      editTimer = setTimeout(() => {
        if (currentDoc.value.source !== next) return
        refreshEditorGeometry()
        refreshPreviewGeometry()
        requestMapping('edit')
      }, 220)
    },
  )

  onBeforeUnmount(() => {
    persistNow()
    saver.endSession(currentDocId.value)
    observers.forEach((fn) => fn())
    mirror?.destroy()
    engine?.destroy()
    clearTimeout(editTimer)
  })

  // 调试控制（对应测试场景：乱序 / 懒加载失败）
  function setServiceMode(m) {
    service.setMode(m)
  }
  function failNextMapping() {
    service.failNext()
    requestMapping('manual-retry')
  }

  return {
    currentDocId,
    currentDoc,
    previewHtml,
    locked,
    mode,
    status,
    syncStats,
    editorEl,
    previewEl,
    mount,
    toggleLock,
    switchDoc,
    setServiceMode,
    failNextMapping,
    refreshNow: () => scheduleRelayout('manual'),
  }
}
