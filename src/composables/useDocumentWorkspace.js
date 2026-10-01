import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from 'vue'
import { demoDocuments } from '../data/demoDocuments'
import { createFeedbackGate } from '../core/feedbackGate.js'
import {
  bookmarkFromSourceAnchor,
  clamp,
  deserializePosition,
  emptyMappingBundle,
  layoutPositionToSource,
  resolveBookmark,
  sourceAnchorToLayout,
  SYNC_EPSILON_PX,
} from '../core/positionMapping.js'
import { parseSourceDocument } from '../core/sourceDocument.js'
import { isCurrentPosition, isCurrentResponse } from '../core/requestIdentity.js'
import { renderLayout } from '../services/layoutServer.js'
import {
  getReadingPosition,
  saveLayoutVersion,
  saveReadingPosition,
} from '../services/readingDatabase.js'

function rafDouble() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

function debounced(fn, wait) {
  let timer = 0
  const debouncedFn = (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
  debouncedFn.flush = async (...args) => {
    clearTimeout(timer)
    return fn(...args)
  }
  debouncedFn.cancel = () => clearTimeout(timer)
  return debouncedFn
}

export function useDocumentWorkspace() {
  const documents = demoDocuments
  const activeDocumentId = ref(documents[0].id)
  const source = ref(documents[0].source)
  const model = computed(() => parseSourceDocument(source.value))

  const editorRef = ref(null)
  const previewRef = ref(null)
  const mirrorRef = ref(null)

  const previewHtml = ref('')
  const bundle = shallowRef(emptyMappingBundle())
  const locked = ref(true)
  const alternateFont = ref(false)
  const loadingLayout = ref(false)
  const layoutError = ref('')
  const degraded = ref(false)
  const confidence = ref('idle')
  const driftPx = ref(0)
  const saveState = ref('未保存')
  const restoreState = ref('')

  const lastSourceAnchor = shallowRef(null)
  const lastPreviewAnchor = shallowRef(null)
  const gate = createFeedbackGate()

  let renderSeq = 0
  let sessionToken = 0
  const userId = 'local-user'
  let abortController = null
  let syncFrame = 0
  let resizeObserver = null

  const activeDocument = computed(() =>
    documents.find((doc) => doc.id === activeDocumentId.value) || documents[0])

  const lineCount = computed(() => source.value.split(/\r?\n/).length)
  const charCount = computed(() => source.value.length)
  const mappingReady = computed(() =>
    !bundle.value.degraded && bundle.value.sourceRevisionHash === model.value.sourceRevisionHash)

  function ensureScroller() {
    if (!editorRef.value || !previewRef.value || !mirrorRef.value) return null
    return {
      editor: editorRef.value,
      preview: previewRef.value,
      mirror: mirrorRef.value,
    }
  }

  function updateMirrorText() {
    const dom = ensureScroller()
    if (!dom) return
    dom.mirror.textContent = source.value
  }

  function lineElements() {
    const dom = ensureScroller()
    if (!dom) return []
    return [...dom.mirror.querySelectorAll('.source-line')]
  }

  function sourceYForLine(line, lineRatio = 0) {
    const elements = lineElements()
    const index = clamp(line - 1, 0, elements.length - 1)
    const element = elements[index]
    if (!element) return 0
    return element.offsetTop + element.offsetHeight * clamp(lineRatio, 0, 1)
  }

  function lineAtContentY(contentY) {
    const elements = lineElements()
    if (!elements.length) return { line: 1, ratio: 0 }
    for (let i = 0; i < elements.length; i += 1) {
      const element = elements[i]
      if (contentY < element.offsetTop + element.offsetHeight) {
        return {
          line: i + 1,
          ratio: clamp((contentY - element.offsetTop) / Math.max(1, element.offsetHeight), 0, 1),
        }
      }
    }
    const last = elements[elements.length - 1]
    return {
      line: elements.length,
      ratio: clamp((contentY - last.offsetTop) / Math.max(1, last.offsetHeight), 0, 1),
    }
  }

  function captureSourceAnchorAt(contentY) {
    const { line, ratio } = lineAtContentY(contentY)
    const node = model.value.nodeAtLine.get(line)
    if (!node) {
      return { sourceLine: line, lineRatio: ratio, nodeRatio: 0 }
    }
    const nodeSpan = Math.max(1, node.lineEnd - node.lineStart + 1)
    return {
      sourceNodeId: node.id,
      sourceNodeFingerprint: node.fingerprint,
      sourceLine: line,
      lineRatio: ratio,
      nodeRatio: clamp((line - node.lineStart + ratio) / nodeSpan, 0, 1),
      headingPath: node.headingPath,
    }
  }

  function currentSourceAnchor() {
    const dom = ensureScroller()
    if (!dom) return null
    const center = dom.editor.scrollTop + dom.editor.clientHeight / 2
    const anchor = captureSourceAnchorAt(center)
    lastSourceAnchor.value = anchor
    return anchor
  }

  function measurePreview() {
    const dom = ensureScroller()
    const measurements = new Map()
    if (!dom) return measurements
    const previewRect = dom.preview.getBoundingClientRect()
    dom.preview.querySelectorAll('[data-layout-id]').forEach((element) => {
      const rect = element.getBoundingClientRect()
      const id = element.dataset.layoutId
      measurements.set(id, {
        id,
        y: dom.preview.scrollTop + rect.top - previewRect.top,
        height: rect.height,
      })
    })
    return measurements
  }

  function currentPreviewAnchor() {
    const dom = ensureScroller()
    if (!dom) return null
    const centerY = dom.preview.scrollTop + dom.preview.clientHeight / 2
    const result = layoutPositionToSource(bundle.value, centerY, measurePreview())
    if (result.anchor) {
      lastPreviewAnchor.value = result.anchor
      confidence.value = result.confidence
    }
    return result.anchor
  }

  function setScrollTop(target, top, origin) {
    const dom = ensureScroller()
    if (!dom) return
    const element = dom[target]
    const max = Math.max(0, element.scrollHeight - element.clientHeight)
    const normalized = clamp(Math.round(top), 0, max)
    if (gate.isRecentDuplicate(target, normalized)) return
    gate.beginProgrammatic(target, normalized, origin)
    element.scrollTop = normalized
    gate.rememberApplied(target, normalized)
  }

  function restoreEditorFromAnchor(anchor, origin) {
    if (!anchor) return
    const resolved = resolveBookmark(model.value, anchor)
    const target = resolved.anchor
    lastSourceAnchor.value = target
    updateMirrorText()
    const y = sourceYForLine(target.sourceLine, target.lineRatio)
    const dom = ensureScroller()
    if (dom) setScrollTop('editor', y - dom.editor.clientHeight / 2, origin)
  }

  function restorePreviewFromAnchor(anchor, origin) {
    if (!anchor) return
    const resolved = resolveBookmark(model.value, anchor)
    const target = resolved.anchor
    lastPreviewAnchor.value = target
    const result = sourceAnchorToLayout(bundle.value, model.value, target, measurePreview())
    const dom = ensureScroller()
    if (!dom) return
    if (Number.isFinite(result.y)) {
      driftPx.value = Math.round(result.drift || 0)
      confidence.value = result.confidence
      degraded.value = false
      setScrollTop('preview', result.y - dom.preview.clientHeight / 2, origin)
    } else {
      degraded.value = true
      confidence.value = 'percentage-fallback'
      const ratio = clamp(target.nodeRatio ?? target.lineRatio ?? 0, 0, 1)
      setScrollTop('preview', ratio * Math.max(0, dom.preview.scrollHeight - dom.preview.clientHeight), origin)
    }
  }

  function syncFromEditor() {
    const dom = ensureScroller()
    const anchor = currentSourceAnchor()
    if (!dom || !anchor) return
    if (!locked.value) return
    if (!mappingReady.value) {
      confidence.value = 'stale-layout'
      scheduleRender()
      return
    }
    const result = sourceAnchorToLayout(bundle.value, model.value, anchor, measurePreview())
    if (Number.isFinite(result.y)) {
      driftPx.value = Math.round(result.drift || 0)
      confidence.value = result.confidence
      degraded.value = false
      setScrollTop('preview', result.y - dom.preview.clientHeight / 2, 'editor')
    } else {
      degraded.value = true
      confidence.value = 'percentage-fallback'
      const editorMax = Math.max(1, dom.editor.scrollHeight - dom.editor.clientHeight)
      const previewMax = Math.max(0, dom.preview.scrollHeight - dom.preview.clientHeight)
      setScrollTop('preview', (dom.editor.scrollTop / editorMax) * previewMax, 'editor')
    }
  }

  function syncFromPreview() {
    const dom = ensureScroller()
    if (!dom || !locked.value) return
    if (!mappingReady.value) {
      confidence.value = 'stale-layout'
      scheduleRender()
      return
    }
    const result = layoutPositionToSource(
      bundle.value,
      dom.preview.scrollTop + dom.preview.clientHeight / 2,
      measurePreview(),
    )
    const anchor = result.anchor
    if (!anchor) {
      degraded.value = true
      confidence.value = 'percentage-fallback'
      const editorMax = Math.max(0, dom.editor.scrollHeight - dom.editor.clientHeight)
      const previewMax = Math.max(1, dom.preview.scrollHeight - dom.preview.clientHeight)
      setScrollTop('editor', (dom.preview.scrollTop / previewMax) * editorMax, 'preview')
      return
    }
    lastPreviewAnchor.value = anchor
    confidence.value = result.confidence
    degraded.value = false
    const y = sourceYForLine(anchor.sourceLine, anchor.lineRatio)
    setScrollTop('editor', y - dom.editor.clientHeight / 2, 'preview')
  }

  function scheduleSync(origin) {
    if (!locked.value) return
    cancelAnimationFrame(syncFrame)
    syncFrame = requestAnimationFrame(() => {
      if (origin === 'editor') syncFromEditor()
      else syncFromPreview()
    })
  }

  async function renderBundle({ restore = null, session = sessionToken } = {}) {
    const requestId = ++renderSeq
    const documentId = activeDocumentId.value
    const requestedSource = source.value
    abortController?.abort()
    abortController = new AbortController()
    loadingLayout.value = true
    layoutError.value = ''
    try {
      const response = await renderLayout(requestedSource, { signal: abortController.signal })
      const requestedIdentity = { requestSeq: requestId, sessionToken: session, documentId, userId }
      const currentIdentity = {
        requestSeq: renderSeq,
        sessionToken,
        documentId: activeDocumentId.value,
        userId,
      }
      // Out-of-order packet or a document switch must not replace the current map.
      if (!isCurrentResponse(currentIdentity, requestedIdentity)) return
      updateMirrorText()
      previewHtml.value = response.html
      bundle.value = { ...response, documentId, degraded: false }
      degraded.value = false
      loadingLayout.value = false
      saveLayoutVersion({
        documentId,
        userId,
        layoutVersion: response.layoutVersion,
        sourceRevisionHash: response.sourceRevisionHash,
        sourceRanges: response.sourceRanges,
        layoutNodes: response.layoutNodes,
      })
      await nextTick()
      await rafDouble()
      if (!isCurrentResponse({
        requestSeq: renderSeq,
        sessionToken,
        documentId: activeDocumentId.value,
        userId,
      }, requestedIdentity)) return
      if (restore) {
        restoreState.value = restore.status
        restoreEditorFromAnchor(restore.anchor, 'restore')
        if (locked.value) {
          syncFromEditor()
        } else if (restore.previewAnchor) {
          restorePreviewFromAnchor(restore.previewAnchor, 'restore')
        }
      } else {
        reanchorAfterMutation('render')
      }
      schedulePositionSave()
    } catch (error) {
      if (error?.name === 'AbortError') return
      if (!isCurrentResponse({
        requestSeq: renderSeq,
        sessionToken,
        documentId: activeDocumentId.value,
        userId,
      }, { requestSeq: requestId, sessionToken: session, documentId, userId })) return
      loadingLayout.value = false
      layoutError.value = '布局映射获取失败，已降级为比例同步'
      degraded.value = true
      confidence.value = 'percentage-fallback'
      bundle.value = emptyMappingBundle()
    }
  }

  const scheduleRender = debounced(() => renderBundle(), 160)

  async function reanchorAfterMutation(origin = 'relayout') {
    await nextTick()
    await rafDouble()
    updateMirrorText()
    if (locked.value) {
      if (lastSourceAnchor.value) restoreEditorFromAnchor(lastSourceAnchor.value, origin)
      syncFromEditor()
    } else {
      if (lastSourceAnchor.value) restoreEditorFromAnchor(lastSourceAnchor.value, origin)
      if (lastPreviewAnchor.value) restorePreviewFromAnchor(lastPreviewAnchor.value, origin)
    }
    schedulePositionSave()
  }

  const scheduleRelayout = debounced(() => reanchorAfterMutation('relayout'), 80)

  function onScroll(side) {
    return (event) => {
      const target = side
      const top = event.target.scrollTop
      if (gate.shouldIgnoreScroll(target, top, side, { epsilon: SYNC_EPSILON_PX })) return
      if (target === 'editor') currentSourceAnchor()
      else currentPreviewAnchor()
      scheduleSync(side)
      schedulePositionSave()
    }
  }

  function buildPositionRecord() {
    const dom = ensureScroller()
    const sourceAnchor = currentSourceAnchor()
    const previewAnchor = mappingReady.value
      ? currentPreviewAnchor()
      : lastPreviewAnchor.value
    return {
      documentId: activeDocumentId.value,
      userId,
      layoutVersion: bundle.value.layoutVersion || '',
      sourceRevisionHash: model.value.sourceRevisionHash,
      locked: locked.value,
      sourceBookmark: bookmarkFromSourceAnchor(sourceAnchor),
      previewBookmark: previewAnchor ? bookmarkFromSourceAnchor(previewAnchor) : null,
      previewRatio: dom ? dom.preview.scrollTop / Math.max(1, dom.preview.scrollHeight - dom.preview.clientHeight) : 0,
      editorScrollTop: dom?.editor.scrollTop ?? 0,
      previewScrollTop: dom?.preview.scrollTop ?? 0,
      updatedAt: Date.now(),
    }
  }

  async function persistPosition(record, reason = 'scroll') {
    if (!record?.documentId) return
    saveState.value = '保存中…'
    await saveReadingPosition(record)
    // The key is embedded in record. Updating UI is the only thing gated by
    // the current selection; the old position never becomes the new document id.
    if (isCurrentPosition({ documentId: activeDocumentId.value, userId }, record)) {
      saveState.value = reason === 'switch' ? '上一篇位置已保存' : '位置已保存'
    }
  }

  const schedulePositionSave = debounced(() => persistPosition(buildPositionRecord()), 420)

  async function restoreInitialPosition(session) {
    const saved = await getReadingPosition(activeDocumentId.value, userId)
    const parsed = saved || deserializePosition(saved)
    if (session !== sessionToken) return
    const sourceBookmark = parsed?.sourceBookmark || parsed
    const sourceResolution = resolveBookmark(model.value, sourceBookmark)
    return {
      anchor: sourceResolution.anchor,
      previewAnchor: resolveBookmark(model.value, parsed?.previewBookmark || sourceBookmark).anchor,
      status: sourceResolution.status,
    }
  }

  async function selectDocument(id) {
    if (id === activeDocumentId.value) return
    await persistPosition(buildPositionRecord(), 'switch')
    schedulePositionSave.cancel()
    scheduleRender.cancel()
    sessionToken += 1
    renderSeq += 1
    abortController?.abort()
    gate.clear()
    activeDocumentId.value = id
    source.value = documents.find((doc) => doc.id === id)?.source || ''
    previewHtml.value = ''
    bundle.value = emptyMappingBundle()
    lastSourceAnchor.value = null
    lastPreviewAnchor.value = null
    confidence.value = 'loading'
    saveState.value = '未保存'
    restoreState.value = ''
    updateMirrorText()
    await nextTick()
    editorRef.value.scrollTop = 0
    previewRef.value.scrollTop = 0
    const session = sessionToken
    const restore = await restoreInitialPosition(session)
    renderBundle({ restore, session })
  }

  function onSourceInput(event) {
    source.value = event.target.value
    updateMirrorText()
    confidence.value = 'editing'
    scheduleRender()
    schedulePositionSave()
  }

  function resetToDemo() {
    source.value = activeDocument.value.source
    updateMirrorText()
    scheduleRender()
  }

  function clearAll() {
    source.value = ''
    previewHtml.value = ''
    bundle.value = emptyMappingBundle()
    updateMirrorText()
  }

  function toggleLock() {
    // No forced alignment here: unlocking preserves both current positions.
    locked.value = !locked.value
    if (locked.value) scheduleSync('editor')
    schedulePositionSave()
  }

  function toggleFont() {
    alternateFont.value = !alternateFont.value
    document.documentElement.classList.toggle('alternate-font', alternateFont.value)
    scheduleRelayout()
  }

  function onPreviewClick(event) {
    const button = event.target.closest('.fold-button')
    if (!button) return
    const wrapper = button.closest('[data-foldable="true"]')
    if (!wrapper) return
    const collapsed = wrapper.classList.toggle('collapsed')
    button.setAttribute('aria-expanded', String(!collapsed))
    button.textContent = collapsed ? '展开' : '折叠'
    scheduleRelayout()
  }

  function onPreviewExternalLoad(event) {
    if (event.target.classList?.contains('doc-image')) {
      if (event.type === 'error') event.target.classList.add('broken-image')
      scheduleRelayout()
    }
  }

  let resizeTimer = 0
  function onWindowResize() {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => scheduleRelayout(), 120)
  }

  function flushBeforeHide() {
    persistPosition(buildPositionRecord(), 'hide')
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') flushBeforeHide()
  }

  onMounted(async () => {
    updateMirrorText()
    const dom = ensureScroller()
    dom?.preview.addEventListener('click', onPreviewClick)
    dom?.preview.addEventListener('load', onPreviewExternalLoad, true)
    dom?.preview.addEventListener('error', onPreviewExternalLoad, true)
    window.addEventListener('resize', onWindowResize)
    window.addEventListener('pagehide', flushBeforeHide)
    document.addEventListener('visibilitychange', onVisibilityChange)
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => scheduleRelayout()).catch(() => {})
    }
    if ('ResizeObserver' in window && dom) {
      resizeObserver = new ResizeObserver(() => scheduleRelayout())
      resizeObserver.observe(dom.preview)
      resizeObserver.observe(dom.editor)
    }
    const session = sessionToken
    const restore = await restoreInitialPosition(session)
    renderBundle({ restore, session })
  })

  onBeforeUnmount(() => {
    schedulePositionSave.cancel()
    scheduleRender.cancel()
    sessionToken += 1
    abortController?.abort()
    window.removeEventListener('resize', onWindowResize)
    window.removeEventListener('pagehide', flushBeforeHide)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    const dom = ensureScroller()
    dom?.preview.removeEventListener('click', onPreviewClick)
    dom?.preview.removeEventListener('load', onPreviewExternalLoad, true)
    dom?.preview.removeEventListener('error', onPreviewExternalLoad, true)
    resizeObserver?.disconnect()
  })

  return {
    documents,
    activeDocumentId,
    source,
    model,
    previewHtml,
    editorRef,
    previewRef,
    mirrorRef,
    locked,
    alternateFont,
    loadingLayout,
    layoutError,
    degraded,
    confidence,
    driftPx,
    saveState,
    restoreState,
    lineCount,
    charCount,
    onScroll,
    onSourceInput,
    selectDocument,
    resetToDemo,
    clearAll,
    toggleLock,
    toggleFont,
  }
}
