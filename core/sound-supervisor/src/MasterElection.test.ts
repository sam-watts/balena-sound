import * as assert from 'assert'
import MasterElection, { winsTieBreak } from './MasterElection'

// The two devices this was debugged against, kept because their addresses are the
// case that a naive string comparison gets wrong.
const KITCHEN: string = '192.168.0.80'
const LIVING_ROOM: string = '192.168.0.155'

const clock: { value: number } = { value: 0 }

function election(claimCooldownMs: number = 15000, acceptCooldownMs: number = 15000): MasterElection {
  clock.value = 100000
  return new MasterElection({ claimCooldownMs, acceptCooldownMs, now: () => clock.value })
}

let failures: number = 0

function test(name: string, run: () => void): void {
  try {
    run()
    console.log(`  ok    ${name}`)
  } catch (error) {
    failures++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.message}`)
  }
}

test('an idle device never claims master', () => {
  const e: MasterElection = election()
  assert.strictEqual(e.shouldClaim({ isMaster: false, hasLocalPlayback: false }), false)
})

test('a playing device that is not master claims it', () => {
  const e: MasterElection = election()
  assert.strictEqual(e.shouldClaim({ isMaster: false, hasLocalPlayback: true }), true)
})

test('the master does not re-claim while it keeps playing (no claim storm)', () => {
  const e: MasterElection = election()
  assert.strictEqual(e.shouldClaim({ isMaster: true, hasLocalPlayback: true }), false)
})

test('repeat claims are rate limited, then allowed again after the cooldown', () => {
  const e: MasterElection = election(15000)
  assert.strictEqual(e.shouldClaim({ isMaster: false, hasLocalPlayback: true }), true)

  // A burst of sink events must not turn into a burst of announcements.
  clock.value += 1000
  assert.strictEqual(e.shouldClaim({ isMaster: false, hasLocalPlayback: true }), false)
  clock.value += 1000
  assert.strictEqual(e.shouldClaim({ isMaster: false, hasLocalPlayback: true }), false)

  clock.value += 15000
  assert.strictEqual(e.shouldClaim({ isMaster: false, hasLocalPlayback: true }), true)
})

test('an idle master accepts a claim from a peer, so stranded audio recovers', () => {
  // The production failure: kitchen held master with an IDLE input sink while
  // living_room had the audio, and no snapclient was listening to living_room.
  const e: MasterElection = election()
  assert.strictEqual(e.shouldAccept({
    claimant: LIVING_ROOM,
    claimantPlaying: true,
    selfIp: KITCHEN,
    isNewMaster: true,
    isMaster: true,
    hasLocalPlayback: false,
    locked: false
  }), true)
})

test('a playing master ignores a higher-address claimant (no ping-pong)', () => {
  const e: MasterElection = election()
  assert.strictEqual(e.shouldAccept({
    claimant: LIVING_ROOM,
    claimantPlaying: true,
    selfIp: KITCHEN,
    isNewMaster: true,
    isMaster: true,
    hasLocalPlayback: true,
    locked: false
  }), false)
})

test('a playing master never yields to an idle claimant, whatever its address', () => {
  // The old master re-asserts itself on every fleet-sync. Without this guard a
  // silent device with a lower address takes master back off the device that is
  // actually playing, and every snapclient ends up on a silent snapserver.
  const e: MasterElection = election()
  assert.strictEqual(e.shouldAccept({
    claimant: KITCHEN,
    claimantPlaying: false,
    selfIp: LIVING_ROOM,
    isNewMaster: true,
    isMaster: true,
    hasLocalPlayback: true,
    locked: false
  }), false)
})

test('a playing master yields to a lower-address claimant', () => {
  const e: MasterElection = election()
  assert.strictEqual(e.shouldAccept({
    claimant: KITCHEN,
    claimantPlaying: true,
    selfIp: LIVING_ROOM,
    isNewMaster: true,
    isMaster: true,
    hasLocalPlayback: true,
    locked: false
  }), true)
})

test('a non-master accepts a claim even while playing', () => {
  const e: MasterElection = election()
  assert.strictEqual(e.shouldAccept({
    claimant: LIVING_ROOM,
    claimantPlaying: true,
    selfIp: KITCHEN,
    isNewMaster: true,
    isMaster: false,
    hasLocalPlayback: true,
    locked: false
  }), true)
})

test('a claim for the master we already have is ignored', () => {
  const e: MasterElection = election()
  assert.strictEqual(e.shouldAccept({
    claimant: LIVING_ROOM,
    claimantPlaying: true,
    selfIp: KITCHEN,
    isNewMaster: false,
    isMaster: false,
    hasLocalPlayback: false,
    locked: false
  }), false)
})

test('a locked master (forced or updates disallowed) is never reassigned', () => {
  const e: MasterElection = election()
  assert.strictEqual(e.shouldAccept({
    claimant: LIVING_ROOM,
    claimantPlaying: true,
    selfIp: KITCHEN,
    isNewMaster: true,
    isMaster: true,
    hasLocalPlayback: false,
    locked: true
  }), false)
})

test('accepting is rate limited, bounding how often the snapclient restarts', () => {
  const e: MasterElection = election(15000, 15000)
  const claim = (claimant: string): boolean => e.shouldAccept({
    claimant,
    claimantPlaying: true,
    selfIp: KITCHEN,
    isNewMaster: true,
    isMaster: false,
    hasLocalPlayback: false,
    locked: false
  })

  assert.strictEqual(claim(LIVING_ROOM), true)
  clock.value += 2000
  assert.strictEqual(claim(KITCHEN), false)
  clock.value += 14000
  assert.strictEqual(claim(KITCHEN), true)
})

test('after yielding to a playing peer we stop competing for master', () => {
  // The observed ping-pong: living_room has a turntable looped into its input sink,
  // so the sink is RUNNING even with nothing on the platter. It yielded to kitchen
  // and re-claimed a heartbeat later, every 60s, restarting a snapclient each time.
  const e: MasterElection = election()
  e.deferTo()
  assert.strictEqual(e.shouldClaim({ isMaster: false, hasLocalPlayback: true }), false)
})

test('standing down lapses once the playing peer goes quiet', () => {
  const e: MasterElection = new MasterElection({
    claimCooldownMs: 0,
    deferToPlayingMasterMs: 90000,
    now: () => clock.value
  })
  clock.value = 100000
  e.deferTo()

  clock.value += 60000
  assert.strictEqual(e.shouldClaim({ isMaster: false, hasLocalPlayback: true }), false, 'still deferring at 60s')

  // Nothing refreshed it, so the peer has stopped playing and we can take over.
  clock.value += 31000
  assert.strictEqual(e.shouldClaim({ isMaster: false, hasLocalPlayback: true }), true)
})

test('a re-asserting playing peer keeps refreshing the stand-down', () => {
  const e: MasterElection = new MasterElection({
    claimCooldownMs: 0,
    deferToPlayingMasterMs: 90000,
    now: () => clock.value
  })
  clock.value = 100000

  // Peer re-asserts itself every 60s while it keeps playing.
  for (let i = 0; i < 5; i++) {
    e.deferTo()
    clock.value += 60000
    assert.strictEqual(e.shouldClaim({ isMaster: false, hasLocalPlayback: true }), false, `still deferring at cycle ${i}`)
  }
})

test('the tie break ranks addresses numerically, not as strings', () => {
  // '192.168.0.155' < '192.168.0.80' as a string, but .80 is the lower address.
  assert.strictEqual(KITCHEN < LIVING_ROOM, false, 'precondition: string order is misleading here')
  assert.strictEqual(winsTieBreak(KITCHEN, LIVING_ROOM), true)
  assert.strictEqual(winsTieBreak(LIVING_ROOM, KITCHEN), false)
  assert.strictEqual(winsTieBreak('10.0.0.9', '10.0.0.10'), true)
})

console.log(failures === 0 ? '\nMasterElection: all tests passed' : `\nMasterElection: ${failures} test(s) failed`)
process.exit(failures === 0 ? 0 : 1)
