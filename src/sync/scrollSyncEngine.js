// 位置同步引擎（纯逻辑，不直接触碰 DOM）。
//
// 同步模型：
//   源行坐标 s 是中间语言。每侧几何 geometry 提供 sToY / yToS。
//   锁定时，一侧以“视口焦点行”（距顶部 focalRatio 处）映射到另一侧，
//   而非按两个容器的滚动百分比硬同步。
//
// 反馈环防护：
//   1) 每次程序滚动携带 origin token；onScroll 回传同一 token 即视为回声，忽略
//   2) 程序滚动只对“另一侧”发生，从不回写发起端
//   3) 校正最多 maxVerifyPasses 轮，残差收敛即停
//   4) 看门狗统计程序滚动频率，异常超阈值熔断，杜绝无穷跳动
const OTHER = { editor: 'preview', preview: 'editor' }

export function createScrollSyncEngine(config = {}) {
  const {
    sides,
    lock,
    focalRatio = 0.24,
    now = () => Date.now(),
    requestFrame = (fn) => setTimeout(fn, 16),
    cancelFrame = (id) => clearTimeout(id),
    onPersist = null,
    onEvent = null,
    tolerancePx = 1.5,
    maxVerifyPasses = 2,
  } = config

  const state = {
    lock: lock !== undefined ? lock : true,
    geometries: { editor: null, preview: null },
    // 当前程序滚动的令牌：{ token, side, expiresAt }
    programmatic: null,
    tokenSeq: 0,
    lastUserScrollAt: 0,
    // 每侧最近一次“用户滚动”得到的焦点源行，解锁后各自保留
    lastS: { editor: 0.5, preview: 0.5 },
    rafId: null,
    relayoutQueued: false,
    deferCount: 0,
    // 看门狗：窗口内程序滚动计数
    watchdog: [],
    halted: false,
    mode: 'mapping', // 'mapping' | 'ratio'
  }

  const WATCHDOG_WINDOW = 1000
  const WATCHDOG_LIMIT = 100
  const PROGRAMMATIC_TTL = 500
  const USER_GUARD_MS = 180
  const MAX_DEFERS = 10

  function emit(type, detail = {}) {
    if (onEvent) onEvent({ type, at: now(), ...detail })
  }

  function watchdogRecord(side) {
    const t = now()
    state.watchdog.push({ t, side })
    state.watchdog = state.watchdog.filter((e) => t - e.t <= WATCHDOG_WINDOW)
    if (state.watchdog.length > WATCHDOG_LIMIT && !state.halted) {
      state.halted = true
      emit('watchdog-halt', { count: state.watchdog.length })
    }
  }

  function isProgrammaticEcho(origin) {
    const p = state.programmatic
    if (!origin || !p) return false
    return origin === p.token && now() <= p.expiresAt
  }

  function clearExpiredProgrammatic() {
    if (state.programmatic && now() > state.programmatic.expiresAt) {
      state.programmatic = null
    }
  }

  // 目标 y 落在视口焦点处时需要的 scrollTop
  function scrollTopForFocal(geo, y) {
    return clamp(y - focalRatio * geo.viewportHeight, 0, geo.maxScroll)
  }

  function focalY(side) {
    const geo = state.geometries[side]
    return geo.viewportHeight * focalRatio + sideOf(side).getScrollTop()
  }

  function sideOf(name) {
    return typeof sides[name] === 'function' ? sides[name]() : sides[name]
  }

  function setScrollProgrammatic(side, targetTop) {
    if (state.halted) return false
    const geo = state.geometries[side]
    if (!geo) return false
    const target = sideOf(side)
    if (!target) return false
    const top = clamp(targetTop, 0, geo.maxScroll)
    if (Math.abs(top - target.getScrollTop()) < 0.5) return false
    state.tokenSeq += 1
    const token = `pgm-${state.tokenSeq}-${now()}`
    state.programmatic = { token, side, expiresAt: now() + PROGRAMMATIC_TTL }
    target.setScrollTop(top, { origin: token })
    watchdogRecord(side)
    emit('programmatic-scroll', { side, top, token })
    return true
  }

  // 以 sourceSide 当前焦点源行映射到 targetSide
  function syncFromTo(sourceSide, targetSide, reason) {
    const gSrc = state.geometries[sourceSide]
    const gTgt = state.geometries[targetSide]
    if (!gSrc || !gTgt) return false

    let targetTop
    if (state.mode === 'mapping' && gSrc.hasMapping && gTgt.hasMapping) {
      const s = gSrc.yToS(focalY(sourceSide))
      if (s == null) return false
      state.lastS[sourceSide] = s
      const y = gTgt.sToY(s)
      if (y == null) return false
      targetTop = scrollTopForFocal(gTgt, y)
    } else {
      // 无映射自动降级：容器比例对齐（显式隔离的降级路径）
      const ratio = gSrc.maxScroll <= 0 ? 0 : focalY(sourceSide) / Math.max(gSrc.contentHeight, gSrc.viewportHeight)
      const y = ratio * Math.max(gTgt.contentHeight, gTgt.viewportHeight)
      targetTop = scrollTopForFocal(gTgt, y)
    }
    emit('sync', { sourceSide, targetSide, reason, mode: state.mode })
    return setScrollProgrammatic(targetSide, targetTop)
  }

  // —— 对外事件 ——

  function handleScroll(side, payload = {}) {
    if (state.halted) return
    clearExpiredProgrammatic()

    if (isProgrammaticEcho(payload.origin)) {
      emit('echo-suppressed', { side })
      return
    }

    // 真实用户滚动（或未知来源滚动，按用户滚动处理）
    state.lastUserScrollAt = now()
    const geo = state.geometries[side]
    if (geo) {
      const s = geo.yToS(focalY(side))
      if (s != null) state.lastS[side] = s
    }
    emit('user-scroll', { side })
    if (onPersist) onPersist({ side, at: now() })

    if (state.lock) {
      syncFromTo(side, OTHER[side], 'lock-scroll')
    }
  }

  // 校正：程序滚动后浏览器真实落点可能因折叠/图片/字体替换产生残差
  function verifyPosition(side, expectedS, passesLeft = maxVerifyPasses) {
    if (state.halted || !state.lock) return
    const gTgt = state.geometries[side]
    if (!gTgt || !gTgt.hasMapping) return
    const actualS = gTgt.yToS(focalY(side))
    if (actualS == null) return
    // 将源行残差换算成像素残差（用目标侧相邻锚点的平均尺度）
    const expectedY = gTgt.sToY(expectedS)
    const actualY = gTgt.sToY(actualS)
    const deltaPx = expectedY - actualY
    if (Math.abs(deltaPx) < tolerancePx || passesLeft <= 0) return
    if (Math.abs(expectedS - actualS) > (gTgt.totalLines || 1) * 0.6) return // 异常大残差不盲修
    setScrollProgrammatic(side, sideOf(side).getScrollTop() + deltaPx)
    requestFrame(() => verifyPosition(side, expectedS, passesLeft - 1))
  }

  function relayout(reason = 'unknown') {
    if (state.relayoutQueued) return
    state.relayoutQueued = true
    state.rafId = requestFrame(() => {
      state.relayoutQueued = false
      // 用户刚刚还在操作：推迟一次，避免校正与用户手势打架
      if (now() - state.lastUserScrollAt < USER_GUARD_MS && state.deferCount < MAX_DEFERS) {
        state.deferCount += 1
        emit('relayout-deferred', { reason, deferCount: state.deferCount })
        relayout(reason)
        return
      }
      state.deferCount = 0

      // 以“主侧”当前焦点源行为准重新定位（锁定时编辑为发起端，解锁时两侧各自保留）
      if (state.lock) {
        const s = state.lastS.editor
        const gTgt = state.geometries.preview
        if (gTgt) {
          const y = (state.mode === 'mapping' && gTgt.hasMapping)
            ? gTgt.sToY(s)
            : (s / (gTgt.totalLines + 0.5)) * Math.max(gTgt.contentHeight, gTgt.viewportHeight)
          if (y != null) setScrollProgrammatic('preview', scrollTopForFocal(gTgt, y))
        }
      } else {
        // 解锁：各自按各自最后焦点源行重新定位，双方当前位置都保留
        repositionOwn('editor')
        repositionOwn('preview')
      }
      emit('relayout', { reason, lock: state.lock, mode: state.mode })
    })
  }

  function repositionOwn(side) {
    const geo = state.geometries[side]
    if (!geo) return
    const s = state.lastS[side]
    const y = geo.hasMapping && state.mode === 'mapping'
      ? geo.sToY(s)
      : (s / (geo.totalLines + 0.5)) * Math.max(geo.contentHeight, geo.viewportHeight)
    if (y != null) setScrollProgrammatic(side, scrollTopForFocal(geo, y))
  }

  function setGeometry(side, geometry) {
    state.geometries[side] = geometry
    emit('geometry', { side, hasMapping: geometry?.hasMapping })
  }

  function setMode(mode) {
    if (mode !== state.mode) {
      state.mode = mode
      emit('mode', { mode })
    }
  }

  // 锁定/解锁：切换瞬间不强制跳位；解锁保留双方当前位置
  function setLock(nextLock) {
    const locked = !!nextLock
    if (locked === state.lock) return
    state.lock = locked
    emit(locked ? 'locked' : 'unlocked', {
      editorS: state.lastS.editor,
      previewS: state.lastS.preview,
    })
    if (locked) {
      // 重新锁定：以编辑器当前位置为准对齐一次
      syncFromTo('editor', 'preview', 'relock')
    }
    // 解锁时什么都不做：两侧停在各自当前位置
  }

  // 恢复书签
  function restoreAt({ side = 'editor', s = null, scrollTop = null, verify = true } = {}) {
    const geo = state.geometries[side]
    if (!geo) return false
    if (scrollTop != null) {
      setScrollProgrammatic(side, clamp(scrollTop, 0, geo.maxScroll))
    } else if (s != null) {
      const y = geo.hasMapping && state.mode === 'mapping'
        ? geo.sToY(s)
        : (s / (geo.totalLines + 0.5)) * Math.max(geo.contentHeight, geo.viewportHeight)
      if (y != null) {
        setScrollProgrammatic(side, scrollTopForFocal(geo, y))
        state.lastS[side] = s
      }
    }
    if (state.lock) {
      const other = OTHER[side]
      syncFromTo(side, other, 'restore')
      if (verify && s != null) {
        requestFrame(() => verifyPosition(other, s))
      }
    }
    return true
  }

  function getState() {
    return {
      lock: state.lock,
      mode: state.mode,
      halted: state.halted,
      lastS: { ...state.lastS },
    }
  }

  function destroy() {
    if (state.rafId) cancelFrame(state.rafId)
    state.halted = true
  }

  // 测试/恢复用：重置看门狗
  function resetWatchdog() {
    state.watchdog = []
    state.halted = false
  }

  return {
    handleScroll,
    setGeometry,
    setMode,
    setLock,
    relayout,
    restoreAt,
    verifyPosition,
    getState,
    resetWatchdog,
    destroy,
  }
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v))
}
