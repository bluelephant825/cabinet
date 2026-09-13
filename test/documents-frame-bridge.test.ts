/**
 * Pure-logic tests for the document-editor postMessage bridge validator —
 * jsdom-free; only parseBridgeMessage is exercised.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseBridgeMessage, BRIDGE_MARKER } from '../src/lib/documents/frame-bridge'

const CHANNEL = 'doc-test-channel'

const msg = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  cabinetDoc: BRIDGE_MARKER,
  channel: CHANNEL,
  type: 'ready',
  ...extra,
})

test('valid frame→host message is accepted', () => {
  const parsed = parseBridgeMessage(msg(), { channel: CHANNEL, direction: 'frame-to-host' })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.message?.type, 'ready')
})

test('valid host→frame message is accepted', () => {
  const parsed = parseBridgeMessage(msg({ type: 'init' }), {
    channel: CHANNEL,
    direction: 'host-to-frame',
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.message?.type, 'init')
})

test('missing marker is rejected', () => {
  const { cabinetDoc: _omit, ...rest } = msg()
  const parsed = parseBridgeMessage(rest, { channel: CHANNEL, direction: 'frame-to-host' })
  assert.equal(parsed.ok, false)
})

test('wrong channel is rejected', () => {
  const parsed = parseBridgeMessage(msg({ channel: 'other' }), {
    channel: CHANNEL,
    direction: 'frame-to-host',
  })
  assert.equal(parsed.ok, false)
})

test('unknown type is rejected', () => {
  const parsed = parseBridgeMessage(msg({ type: 'eval' }), {
    channel: CHANNEL,
    direction: 'frame-to-host',
  })
  assert.equal(parsed.ok, false)
})

test('a type only valid in the other direction is rejected', () => {
  // `init` is host→frame only; a frame must not be able to spoof it.
  const parsed = parseBridgeMessage(msg({ type: 'init' }), {
    channel: CHANNEL,
    direction: 'frame-to-host',
  })
  assert.equal(parsed.ok, false)
})

test('non-object payloads are rejected', () => {
  for (const data of [null, undefined, 'ready', 42, ['ready']]) {
    const parsed = parseBridgeMessage(data, { channel: CHANNEL, direction: 'frame-to-host' })
    assert.equal(parsed.ok, false, `expected rejection for ${JSON.stringify(data)}`)
  }
})
