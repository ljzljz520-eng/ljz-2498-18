import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createFeedbackGate } from '../src/core/feedbackGate.js'

describe('feedback gate', () => {
  it('ignores the echo from a programmatic scroll but allows later user scroll', () => {
    let time = 100
    const gate = createFeedbackGate({ now: () => time, ttlMs: 500 })
    gate.beginProgrammatic('preview', 120, 'editor')

    assert.equal(gate.shouldIgnoreScroll('preview', 120, 'preview'), true)
    time = 200
    assert.equal(gate.shouldIgnoreScroll('preview', 300, 'preview'), false)
  })

  it('tolerates browser clamping within the epsilon but does not suppress forever', () => {
    let time = 0
    const gate = createFeedbackGate({ now: () => time, ttlMs: 500 })
    gate.beginProgrammatic('editor', 100, 'preview')
    assert.equal(gate.shouldIgnoreScroll('editor', 101, 'editor'), true)
    time = 600
    assert.equal(gate.shouldIgnoreScroll('editor', 101, 'editor'), false)
  })
})
