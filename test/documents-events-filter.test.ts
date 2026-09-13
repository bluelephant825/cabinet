/**
 * Pure tests for the events-relay channel filter — jsdom-free.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { matchesChannelFrame } from '../src/lib/documents/events-filter'

test('a frame on the subscribed channel passes', () => {
  const frame = JSON.stringify({
    channel: 'documents',
    type: 'document:changed',
    virtualPath: 'a.docx',
  })
  assert.equal(matchesChannelFrame(frame, 'documents'), true)
})

test('frames from other channels are dropped', () => {
  const frame = JSON.stringify({ channel: 'agents', type: 'agent:done' })
  assert.equal(matchesChannelFrame(frame, 'documents'), false)
})

test('malformed frames are dropped', () => {
  for (const frame of ['not json', '42', '"documents"', 'null', '[1]', '{}']) {
    assert.equal(matchesChannelFrame(frame, 'documents'), false, frame)
  }
})
