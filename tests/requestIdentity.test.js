import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isCurrentPosition, isCurrentResponse } from '../src/core/requestIdentity.js'

describe('request identity guards', () => {
  const context = { documentId: 'a', userId: 'u', requestSeq: 3, sessionToken: 2 }

  it('rejects out-of-order layout responses and switched documents', () => {
    assert.equal(isCurrentResponse(context, { ...context }), true)
    assert.equal(isCurrentResponse(context, { ...context, requestSeq: 2 }), false)
    assert.equal(isCurrentResponse(context, { ...context, documentId: 'b' }), false)
    assert.equal(isCurrentResponse(context, { ...context, sessionToken: 9 }), false)
  })

  it('allows a flushed old position only when its embedded id is still that old document', () => {
    assert.equal(isCurrentPosition(context, { documentId: 'a', userId: 'u' }), true)
    assert.equal(isCurrentPosition(context, { documentId: 'b', userId: 'u' }), false)
    assert.equal(isCurrentPosition(context, { documentId: 'a', userId: 'other' }), false)
  })
})
