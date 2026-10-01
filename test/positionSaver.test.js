import test from 'node:test'
import assert from 'node:assert/strict'
import { createPositionSaver } from '../src/sync/positionSaver.js'
import { createBookmark } from '../src/sync/bookmark.js'

function fakeDb() {
  const saved = new Map()
  return {
    saved,
    savePosition(docId, pos) { saved.set(docId, pos) },
  }
}

function makeClock() {
  let t = 0
  let seq = 0
  const timers = new Map()
  return {
    now: () => t,
    setT(v) { t = v },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id },
    clearTimeout: (id) => timers.delete(id),
    flush(upto) {
      t = upto
      for (const [id, job] of [...timers]) {
        if (job.at <= t) {
          timers.delete(id)
          job.fn()
        }
      }
    },
  }
}

function bm(docId, sig, top) {
  return createBookmark({
    docId,
    layoutVersion: 'v1',
    sourceSignature: sig,
    totalLines: 10,
    editorScrollTop: top,
    previewScrollTop: top,
    anchor: { s: top / 10 },
  })
}

test('防抖保存：时间到后落库', () => {
  const db = fakeDb()
  const clock = makeClock()
  const saver = createPositionSaver(db, { delay: 400, now: clock.now })
  const origSetTimeout = globalThis.setTimeout
  const origClear = globalThis.clearTimeout
  globalThis.setTimeout = clock.setTimeout
  globalThis.clearTimeout = clock.clearTimeout
  try {
    saver.beginSession('d1', 'sigA')
    saver.scheduleSave('d1', 'sigA', bm('d1', 'sigA', 100))
    clock.flush(399)
    assert.equal(db.saved.has('d1'), false)
    clock.flush(800)
    assert.equal(db.saved.get('d1').editor.scrollTop, 100)
  } finally {
    globalThis.setTimeout = origSetTimeout
    globalThis.clearTimeout = origClear
  }
})

test('切稿守卫：用户已切走文稿后，迟到的旧签名保存被拒绝（绝不串稿）', () => {
  const db = fakeDb()
  const clock = makeClock()
  const saver = createPositionSaver(db, { delay: 100, now: clock.now })
  // 直接验证 flush 守卫：旧签名
  saver.beginSession('d1', 'sigA')
  saver.endSession('d1')
  // flushNow 也必须拒绝
  const ok = saver.flushNow('d1', 'sigA', bm('d1', 'sigA', 999))
  assert.equal(ok, false)
  assert.equal(db.saved.has('d1'), false)

  // 新文稿会话中，旧文稿 docId 的保存不能落库
  saver.beginSession('d2', 'sigB')
  const ok2 = saver.flushNow('d1', 'sigA', bm('d1', 'sigA', 888))
  assert.equal(ok2, false)
  assert.equal(db.saved.has('d1'), false)
})

test('切稿前 flushNow：旧位置正确写入旧文稿记录', () => {
  const db = fakeDb()
  const saver = createPositionSaver(db, { delay: 100, now: () => 0 })
  saver.beginSession('d1', 'sigA')
  const ok = saver.flushNow('d1', 'sigA', bm('d1', 'sigA', 777))
  assert.equal(ok, true)
  assert.equal(db.saved.get('d1').editor.scrollTop, 777)
})

test('签名不符的保存（同一 docId 内容已变）被拒绝', () => {
  const db = fakeDb()
  const saver = createPositionSaver(db, { delay: 100, now: () => 0 })
  saver.beginSession('d1', 'sig-new')
  const ok = saver.flushNow('d1', 'sig-old', bm('d1', 'sig-old', 1))
  assert.equal(ok, false)
  assert.equal(db.saved.has('d1'), false)
})
