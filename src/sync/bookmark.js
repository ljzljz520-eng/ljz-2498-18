// 书签：个人阅读位置的持久化载体。
// 同时保存：
//  - 两侧滚动像素（即时恢复用）
//  - 源行锚点 s + 布局分片签名（布局版本变化时迁移用）
//  - 文档/布局版本指纹（识别旧书签、防止串稿）
import { clamp } from './geometry.js'

export function createBookmark({
  docId,
  layoutVersion,
  sourceSignature,
  totalLines,
  editorScrollTop,
  previewScrollTop,
  anchor,
  updatedAt = Date.now(),
}) {
  return {
    docId,
    layoutVersion,
    sourceSignature,
    totalLines,
    editor: { scrollTop: editorScrollTop ?? 0 },
    preview: { scrollTop: previewScrollTop ?? 0 },
    anchor: anchor || null,
    updatedAt,
  }
}

// 在当前布局分片中寻找书签锚点对应的源行
function locateAnchor(fragments, anchor) {
  if (!anchor) return null
  if (anchor.fragmentSignature) {
    const hit = fragments.find((f) => f.signature === anchor.fragmentSignature)
    if (hit) return (hit.startLine + hit.endLine) / 2
  }
  if (Number.isFinite(anchor.ordinal)) {
    // 序数按 startLine*1000+part 编码；仅在距离一个“页内分片”量级内才认为是同一节点
    const ORDINAL_TOLERANCE = 1000
    const candidates = fragments
      .filter((f) => f.ordinal != null && Math.abs(f.ordinal - anchor.ordinal) <= ORDINAL_TOLERANCE)
      .sort((a, b) => Math.abs(a.ordinal - anchor.ordinal) - Math.abs(b.ordinal - anchor.ordinal))
    if (candidates[0]) return (candidates[0].startLine + candidates[0].endLine) / 2
  }
  return null
}

// 恢复书签：布局版本一致时直接用像素；不一致（旧书签）时按签名/序号迁移到新源行
export function restoreBookmark({
  bookmark,
  fragments,
  currentLayoutVersion,
  currentSourceSignature,
  currentTotalLines,
}) {
  if (!bookmark) return null

  const sameLayout = bookmark.layoutVersion === currentLayoutVersion
  const sameSource = bookmark.sourceSignature === currentSourceSignature

  if (sameLayout && sameSource) {
    return {
      migrated: false,
      editorScrollTop: bookmark.editor?.scrollTop ?? 0,
      previewScrollTop: bookmark.preview?.scrollTop ?? 0,
      s: bookmark.anchor?.s ?? null,
    }
  }

  // 旧书签：尝试在新布局中定位同一分片
  let s = locateAnchor(fragments, bookmark.anchor)

  // 内容也变了（签名失效）：退化为按源行比例迁移
  if (s == null && Number.isFinite(bookmark.anchor?.s) && bookmark.totalLines && currentTotalLines) {
    s = clamp((bookmark.anchor.s / bookmark.totalLines) * currentTotalLines, 0.5, currentTotalLines + 0.5)
  }

  return {
    migrated: true,
    s,
    editorScrollTop: null,
    previewScrollTop: null,
  }
}

// 根据源行 s 在分片列表中选出最靠近的锚点信息（供下次迁移）
export function anchorForS(fragments, s) {
  if (!Number.isFinite(s)) return null
  const containing = fragments
    .filter((f) => s >= f.startLine - 0.5 && s <= f.endLine + 0.5)
    .sort((a, b) => Math.abs((a.startLine + a.endLine) / 2 - s) - Math.abs((b.startLine + b.endLine) / 2 - s))[0]
  const pick = containing || fragments
    .slice()
    .sort((a, b) => Math.abs((a.startLine + a.endLine) / 2 - s) - Math.abs((b.startLine + b.endLine) / 2 - s))[0]
  if (!pick) return { s, fragmentSignature: null, ordinal: null }
  return { s, fragmentSignature: pick.signature, ordinal: pick.ordinal }
}
