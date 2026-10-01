import test from 'node:test'
import assert from 'node:assert/strict'
import { createMappingClient } from '../src/sync/mappingClient.js'

// 手工假服务：按调用顺序控制完成时序
function fakeService() {
  const jobs = []
  return {
    calls: 0,
    requestLayout() {
      this.calls += 1
      const id = this.calls
      return new Promise((resolve, reject) => {
        jobs.push({ id, resolve, reject })
      })
    },
    resolve(id, value) {
      jobs.find((j) => j.id === id).resolve(value)
    },
    reject(id, err) {
      jobs.find((j) => j.id === id).reject(err)
    },
  }
}

test('回包乱序：旧请求晚到被判 stale，最新请求结果被接受', async () => {
  const svc = fakeService()
  const client = createMappingClient(svc, { retryOnFailure: 0 })
  const p1 = client.request('d1', 'source-a')
  const p2 = client.request('d1', 'source-b')
  svc.resolve(2, { reqId: 2, docId: 'd1', version: 'v2', fragments: [] })
  const r2 = await p2
  assert.equal(r2.status, 'ok')
  svc.resolve(1, { reqId: 1, docId: 'd1', version: 'v1', fragments: [] })
  const r1 = await p1
  assert.equal(r1.status, 'stale')
  assert.equal(client.getCached('d1').version, 'v2')
})

test('请求失败：无重试直接 error', async () => {
  const svc = fakeService()
  const client = createMappingClient(svc, { retryOnFailure: 0 })
  const p = client.request('d1', 's')
  svc.reject(1, new Error('503'))
  const r = await p
  assert.equal(r.status, 'error')
})

test('失败自动重试一次后成功', async () => {
  let n = 0
  const svc = {
    requestLayout() {
      n += 1
      if (n === 1) return Promise.reject(new Error('boom'))
      return Promise.resolve({ reqId: 9, docId: 'd', version: 'v', fragments: [] })
    },
  }
  const client = createMappingClient(svc, { retryOnFailure: 1 })
  const r = await client.request('d', 's')
  assert.equal(r.status, 'ok')
  assert.equal(n, 2)
})

test('invalidate 让在途旧请求全部作废', async () => {
  const svc = fakeService()
  const client = createMappingClient(svc, { retryOnFailure: 0 })
  const p1 = client.request('d1', 'a')
  client.invalidate()
  const p2 = client.request('d1', 'b')
  svc.resolve(2, { reqId: 2, docId: 'd1', version: 'v2', fragments: [] })
  svc.resolve(1, { reqId: 1, docId: 'd1', version: 'v1', fragments: [] })
  assert.equal((await p2).status, 'ok')
  assert.equal((await p1).status, 'stale')
})

test('多文稿隔离：不同 docId 的缓存互不覆盖', async () => {
  let n = 0
  const svc = {
    requestLayout({ docId }) {
      n += 1
      return Promise.resolve({ reqId: n, docId, version: `v-${docId}`, fragments: [{ docId }] })
    },
  }
  const client = createMappingClient(svc, { retryOnFailure: 0 })
  const rA = await client.request('doc-A', 'a')
  const rB = await client.request('doc-B', 'b')
  assert.equal(rA.status, 'ok')
  assert.equal(rB.status, 'ok')
  assert.equal(client.getCached('doc-A').version, 'v-doc-A')
  assert.equal(client.getCached('doc-B').version, 'v-doc-B')
  // 切回 A 不读到 B 的布局
  assert.notDeepEqual(client.getCached('doc-A'), client.getCached('doc-B'))
})
