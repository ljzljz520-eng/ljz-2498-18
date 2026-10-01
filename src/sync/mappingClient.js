// 映射客户端：对“渲染后端”的请求做生命周期管理。
// 关键：回包可能乱序，必须按请求序号裁决，只接受最新一次请求的结果。
export function createMappingClient(service, options = {}) {
  const { retryOnFailure = 1 } = options
  let latestReq = 0
  let cache = new Map() // key: docId -> layout

  function request(docId, source) {
    const attempted = latestReq + 1
    const myReq = attempted
    latestReq = myReq

    const attempt = (retriesLeft) =>
      service.requestLayout({ docId, source }).then(
        (layout) => {
          if (myReq !== latestReq) {
            // 乱序的旧回包：静默丢弃（已被更新的请求取代）
            return { status: 'stale', reqId: layout.reqId }
          }
          cache.set(docId, layout)
          return { status: 'ok', reqId: layout.reqId, layout }
        },
        (error) => {
          if (myReq !== latestReq) return { status: 'stale', reqId: myReq }
          if (retriesLeft > 0) return attempt(retriesLeft - 1)
          return { status: 'error', reqId: myReq, error }
        },
      )

    return attempt(retryOnFailure)
  }

  // 版本作废：文档内容变化或切换时让在途请求全部失效
  function invalidate(docId) {
    latestReq += 1
    if (docId) cache.delete(docId)
  }

  function hydrate(docId, layout) {
    if (layout) cache.set(docId, layout)
  }

  function getCached(docId) {
    return cache.get(docId) ?? null
  }

  return { request, invalidate, hydrate, getCached }
}
