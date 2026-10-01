// 个人阅读位置保存器：
//  - 防抖批量写入，避免滚动中高频落库
//  - 文档令牌（docId + sourceSignature）双重校验，
//    用户已切换文稿时，迟到的旧文稿保存不会覆盖新文稿的记录
export function createPositionSaver(db, options = {}) {
  const { delay = 400, now = () => Date.now() } = options
  const timers = new Map()
  // 每个 docId 独立的会话版本：切走该文稿后旧版本作废
  const sessions = new Map()

  function scheduleSave(docId, signature, payload) {
    if (!docId) return
    const session = sessions.get(docId)
    if (!session) return // 未 beginSession（已切走的文稿）不允许写入
    if (session.signature !== signature) return // 签名不符：绝不串稿
    if (timers.has(docId)) clearTimeout(timers.get(docId))
    timers.set(docId, setTimeout(() => {
      timers.delete(docId)
      flush(docId, signature, payload)
    }, delay))
  }

  function flush(docId, signature, payload) {
    const session = sessions.get(docId)
    if (!session || session.signature !== signature) {
      return false // 守卫失败：丢弃迟到写入
    }
    db.savePosition(docId, payload)
    return true
  }

  // 立即冲刷（切换文稿前调用，确保旧位置落库到正确文稿）
  function flushNow(docId, signature, payload) {
    if (timers.has(docId)) {
      clearTimeout(timers.get(docId))
      timers.delete(docId)
    }
    return flush(docId, signature, payload)
  }

  function beginSession(docId, signature) {
    sessions.set(docId, { signature, startedAt: now() })
  }

  // 离开文稿：作废该文稿的待写计时器与会话
  function endSession(docId) {
    if (timers.has(docId)) {
      clearTimeout(timers.get(docId))
      timers.delete(docId)
    }
    sessions.delete(docId)
  }

  return { scheduleSave, flushNow, beginSession, endSession }
}
