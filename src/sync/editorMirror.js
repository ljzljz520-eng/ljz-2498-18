// 编辑器逐行测量：
// textarea 的 DOM 不暴露每行位置，因此维护一个与 textarea 完全同规格的隐藏
// mirror div（字体、字号、行高、内边距、宽度、折行规则一致），
// 在其中为每个源行放置一个探针 span 来测量 top/height。
const SYNC_STYLE_PROPS = [
  'boxSizing', 'width',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
  'letterSpacing', 'wordSpacing', 'textIndent', 'whiteSpace', 'tabSize',
]

export function createEditorMirror(textarea) {
  const mirror = document.createElement('div')
  mirror.setAttribute('aria-hidden', 'true')
  mirror.className = 'editor-mirror'
  Object.assign(mirror.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    overflowWrap: 'break-word',
  })
  document.body.appendChild(mirror)

  function syncStyles() {
    const cs = window.getComputedStyle(textarea)
    SYNC_STYLE_PROPS.forEach((prop) => {
      mirror.style[prop] = cs[prop]
    })
    mirror.style.width = `${textarea.clientWidth}px`
    mirror.style.height = 'auto'
    mirror.style.minHeight = '0'
    mirror.style.overflow = 'hidden'
  }

  function renderProbe(source) {
    const doc = document.createDocumentFragment()
    const lines = source.split('\n')
    lines.forEach((line, index) => {
      const span = document.createElement('span')
      span.className = 'ln'
      span.dataset.line = String(index + 1)
      span.textContent = line.length ? line : '​'
      doc.appendChild(span)
    })
    mirror.replaceChildren(doc)
  }

  // 返回 [{ top, height }]（相对 mirror 边框，offsetTop 已包含 padding）
  function measure(source) {
    syncStyles()
    renderProbe(source)
    const lines = source.split('\n')
    const result = lines.map((_, index) => {
      const node = mirror.children[index]
      if (!node) return null
      return {
        top: node.offsetTop,
        height: node.offsetHeight || 0,
      }
    })
    return {
      lineTops: result,
      contentHeight: mirror.scrollHeight,
    }
  }

  function destroy() {
    mirror.remove()
  }

  return { mirror, measure, syncStyles, destroy }
}
