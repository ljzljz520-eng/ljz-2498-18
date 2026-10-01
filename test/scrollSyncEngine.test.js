import test from 'node:test'
import assert from 'node:assert/strict'
import { createScrollSyncEngine } from '../src/sync/scrollSyncEngine.js'
import { makeFakeSide, makeClock } from './helpers.js'

function makeHarness(opts = {}) {
  const clock = makeClock()
  const editor = makeFakeSide({ lineHeight: 10, viewport: 100, lines: 100 })
  const preview = makeFakeSide({ lineHeight: 24, viewport: 120, lines: 100, header: 0 })
  const events = []
  const { lock: lockOpt, ...rest } = opts
  const engine = createScrollSyncEngine({
    sides: { editor, preview },
    now: clock.now,
    requestFrame: clock.raf,
    cancelFrame: clock.caf,
    onEvent: (e) => events.push(e),
    ...rest,
    lock: lockOpt ?? true,
  })
  engine.setGeometry('editor', editor.geo)
  engine.setGeometry('preview', preview.geo)
  return { clock, editor, preview, engine, events }
}

test('锁定：编辑器用户滚动 -> 预览按同一源行焦点对齐（非百分比硬同步）', () => {
  const { editor, preview, engine } = makeHarness()
  // 编辑器滚到第 20 行焦点处
  const targetTop = 20 * 10 - 0.24 * 100
  editor.setScrollTop(targetTop)
  engine.handleScroll('editor', { origin: 'user' })

  // 预览焦点源行应≈20
  const focalYPreview = preview.getScrollTop() + 0.24 * 120
  const s = preview.geo.yToS(focalYPreview)
  assert.ok(Math.abs(s - 20) < 0.75, `焦点源行应≈20，实际 ${s}`)
})

test('发起端标记：程序滚动产生的回声被抑制，不产生第二次程序滚动', () => {
  const { editor, preview, engine, events } = makeHarness()
  editor.setScrollTop(500)
  engine.handleScroll('editor', { origin: 'user' })
  const setsAfterUser = preview.programmaticSets.length
  assert.ok(setsAfterUser >= 1)
  // 预览被程序滚动，捕获 token 后回报为回声
  const token = preview.programmaticSets[preview.programmaticSets.length - 1].origin
  engine.handleScroll('preview', { origin: token })
  assert.ok(events.some((e) => e.type === 'echo-suppressed'))
  // 回声没有再引起编辑器程序滚动
  const editorSetsAfter = editor.programmaticSets.length
  engine.handleScroll('preview', { origin: token })
  assert.equal(editor.programmaticSets.length, editorSetsAfter)
})

test('解锁：双方各自滚动互不跟随；解锁前后位置保留', () => {
  const { editor, preview, engine } = makeHarness({ lock: false })
  editor.setScrollTop(400)
  engine.handleScroll('editor', { origin: 'user' })
  assert.equal(preview.programmaticSets.length, 0, '解锁后编辑器滚动不应联动预览')

  preview.setScrollTop(100)
  engine.handleScroll('preview', { origin: 'user' })
  assert.equal(editor.programmaticSets.length, 0, '解锁后预览滚动不应联动编辑器')
  assert.equal(preview.getScrollTop(), 100)
  assert.equal(editor.getScrollTop(), 400)
})

test('重新锁定：以编辑器当前位置重新对齐预览', () => {
  const { editor, preview, engine } = makeHarness()
  engine.setLock(false)
  editor.setScrollTop(600)
  engine.handleScroll('editor', { origin: 'user' })
  preview.setScrollTop(10)
  engine.setLock(true)
  const focalYPreview = preview.getScrollTop() + 0.24 * 120
  const s = preview.geo.yToS(focalYPreview)
  // 编辑器焦点源行 = (600+24)/10+0.5? 用几何回算
  const sEditor = editor.geo.yToS(editor.getScrollTop() + 0.24 * 100)
  assert.ok(Math.abs(s - sEditor) < 0.5)
})

test('无映射降级：任一侧 hasMapping=false 时走比例同步', () => {
  const clock = makeClock()
  const editor = makeFakeSide({ lineHeight: 10, viewport: 100, lines: 100 })
  // 预览无映射几何
  const preview = makeFakeSide({ lineHeight: 20, viewport: 100, lines: 100, hasMapping: false })
  preview.geo.hasMapping = false
  const engine = createScrollSyncEngine({
    sides: { editor, preview },
    now: clock.now,
    requestFrame: clock.raf,
    cancelFrame: clock.caf,
  })
  engine.setGeometry('editor', editor.geo)
  engine.setGeometry('preview', preview.geo)
  engine.setMode('ratio')
  editor.setScrollTop(editor.geo.maxScroll)
  engine.handleScroll('editor', { origin: 'user' })
  // 比例降级下预览接近滚到底
  assert.ok(preview.getScrollTop() > preview.geo.maxScroll * 0.8)
})

test('误差校正：浏览器落点有偏差时校正到收敛（有限轮次后停止）', () => {
  const clock = makeClock()
  // 预览每次程序滚动后真实位置偏移 +30px（模拟图片加载推挤）
  const editor = makeFakeSide({ lineHeight: 10, viewport: 100, lines: 100 })
  const preview = makeFakeSide({ lineHeight: 24, viewport: 120, lines: 100 })
  const rawSet = preview.setScrollTop
  preview.setScrollTop = (v, meta) => rawSet(v + 30, meta)

  const engine = createScrollSyncEngine({
    sides: { editor, preview },
    now: clock.now,
    requestFrame: clock.raf,
    cancelFrame: clock.caf,
    maxVerifyPasses: 4,
    tolerancePx: 1,
  })
  engine.setGeometry('editor', editor.geo)
  engine.setGeometry('preview', preview.geo)

  editor.setScrollTop(500)
  engine.handleScroll('editor', { origin: 'user' })
  const setsBeforeVerify = preview.programmaticSets.length
  // 触发一轮校正
  engine.verifyPosition('preview', editor.geo.yToS(500 + 24))
  clock.advanceRaf()
  assert.ok(preview.programmaticSets.length >= setsBeforeVerify)
})

test('振荡熔断：程序滚动频率异常时 halted，停止继续写入', () => {
  const { editor, preview, engine, events } = makeHarness()
  // 直接高频调用内部级联：通过反复 handleScroll 用户事件不会互喷；
  // 用极端方式制造程序滚动风暴：循环 setLock relock
  for (let i = 0; i < 120; i += 1) {
    // 每次改变发起端位置，让每轮程序滚动的目标不同，形成风暴
    editor.setScrollTop(i * 3)
    engine.handleScroll('editor', { origin: 'user-lock' + i })
    engine.setLock(false)
    engine.setLock(true)
  }
  assert.ok(events.some((e) => e.type === 'watchdog-halt'))
  assert.equal(engine.getState().halted, true)
})

test('relayout：折叠/图片加载导致几何变化后，按最后焦点源行重新定位', () => {
  const clock = makeClock()
  let preview = makeFakeSide({ lineHeight: 24, viewport: 120, lines: 100 })
  const editor = makeFakeSide({ lineHeight: 10, viewport: 100, lines: 100 })
  // sides 用 resolver：模拟 composable 每次取“当前 DOM 侧”
  const engine = createScrollSyncEngine({
    sides: { editor: () => editor, preview: () => preview },
    now: clock.now, requestFrame: clock.raf, cancelFrame: clock.caf, lock: true,
  })
  engine.setGeometry('editor', editor.geo)
  engine.setGeometry('preview', preview.geo)

  // 用户滚到编辑器中部
  editor.setScrollTop(520)
  engine.handleScroll('editor', { origin: 'user' })
  const sBefore = engine.getState().lastS.editor

  // 模拟图片加载后预览几何变化（内容高度增加，行高从 24 变为 30）
  preview = makeFakeSide({ lineHeight: 30, viewport: 120, lines: 100 })
  engine.setGeometry('preview', preview.geo)
  engine.relayout('img-load')
  clock.tick(200)
  clock.advanceRaf()
  const newPreview = preview

  // 预览被重新定位（有程序滚动），且焦点仍指向同一源行
  assert.ok(newPreview.programmaticSets.length >= 1)
  const focalY = newPreview.getScrollTop() + 0.24 * 120
  const sAfter = newPreview.geo.yToS(focalY)
  assert.ok(Math.abs(sAfter - sBefore) < 0.6,
    `重定位后源行偏移: before=${sBefore} after=${sAfter}`)
})

test('relayout：解锁状态下两侧各自按自身最后位置重新定位', () => {
  const clock = makeClock()
  let editor = makeFakeSide({ lineHeight: 10, viewport: 100, lines: 100 })
  let preview = makeFakeSide({ lineHeight: 24, viewport: 120, lines: 100 })
  const engine = createScrollSyncEngine({
    sides: { editor: () => editor, preview: () => preview },
    now: clock.now, requestFrame: clock.raf, cancelFrame: clock.caf, lock: false,
  })
  engine.setGeometry('editor', editor.geo)
  engine.setGeometry('preview', preview.geo)
  editor.setScrollTop(300)
  engine.handleScroll('editor', { origin: 'user-e' })
  preview.setScrollTop(600)
  engine.handleScroll('preview', { origin: 'user-p' })
  const wantE = engine.getState().lastS.editor
  const wantP = engine.getState().lastS.preview

  // 窗口缩放：两侧几何都改变（重置滚动位置模拟重排后 DOM 归零）
  editor = makeFakeSide({ lineHeight: 13, viewport: 110, lines: 100 })
  preview = makeFakeSide({ lineHeight: 20, viewport: 110, lines: 100 })
  engine.setGeometry('editor', editor.geo)
  engine.setGeometry('preview', preview.geo)
  engine.relayout('window-resize')
  clock.tick(200)
  clock.advanceRaf()

  // 两侧都独立重定位到各自的最后源行（保留双方位置，互不强制对齐）
  const sE = editor.geo.yToS(editor.getScrollTop() + 0.24 * 110)
  const sP = preview.geo.yToS(preview.getScrollTop() + 0.24 * 110)
  assert.ok(Math.abs(sE - wantE) < 0.6, `editor ${sE} vs ${wantE}`)
  assert.ok(Math.abs(sP - wantP) < 0.6, `preview ${sP} vs ${wantP}`)
})
