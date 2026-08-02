import * as assert from 'assert'
import ProjectorPresence from './ProjectorPresence'

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

test('projector appearing starts film mode', () => {
  const p: ProjectorPresence = new ProjectorPresence({ absentSamplesBeforeExit: 1 })
  assert.strictEqual(p.update({ reachable: true, isLocalMode: false }), 'enter')
})

test('an absent projector does nothing', () => {
  const p: ProjectorPresence = new ProjectorPresence({ absentSamplesBeforeExit: 1 })
  assert.strictEqual(p.update({ reachable: false, isLocalMode: false }), 'none')
})

test('a projector that stays visible does not re-enter every poll', () => {
  const p: ProjectorPresence = new ProjectorPresence({ absentSamplesBeforeExit: 1 })
  assert.strictEqual(p.update({ reachable: true, isLocalMode: false }), 'enter')
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(p.update({ reachable: true, isLocalMode: true }), 'none', `poll ${i}`)
  }
})

test('projector going away leaves film mode again', () => {
  const p: ProjectorPresence = new ProjectorPresence({ absentSamplesBeforeExit: 1 })
  p.update({ reachable: true, isLocalMode: false })
  assert.strictEqual(p.update({ reachable: false, isLocalMode: true }), 'exit')
})

test('leaving film mode by hand is not undone while the projector is still on', () => {
  const p: ProjectorPresence = new ProjectorPresence({ absentSamplesBeforeExit: 1 })
  p.update({ reachable: true, isLocalMode: false })          // auto-entered
  p.noteManualToggle(false)                                   // button pressed, now out of film mode

  for (let i = 0; i < 5; i++) {
    assert.strictEqual(p.update({ reachable: true, isLocalMode: false }), 'none', `poll ${i}`)
  }
})

test('the manual override re-arms once the projector goes away and returns', () => {
  const p: ProjectorPresence = new ProjectorPresence({ absentSamplesBeforeExit: 1 })
  p.update({ reachable: true, isLocalMode: false })
  p.noteManualToggle(false)
  assert.strictEqual(p.update({ reachable: true, isLocalMode: false }), 'none')

  p.update({ reachable: false, isLocalMode: false })          // projector off, override cleared
  assert.strictEqual(p.update({ reachable: true, isLocalMode: false }), 'enter')
})

test('film mode chosen by hand survives the projector disappearing', () => {
  // We only undo a switch we made ourselves.
  const p: ProjectorPresence = new ProjectorPresence({ absentSamplesBeforeExit: 1 })
  p.noteManualToggle(true)                                    // user entered film mode via the button
  assert.strictEqual(p.update({ reachable: false, isLocalMode: true }), 'none')
})

test('entering film mode by hand then losing the projector does not fight the user', () => {
  const p: ProjectorPresence = new ProjectorPresence({ absentSamplesBeforeExit: 1 })
  p.noteManualToggle(true)
  p.update({ reachable: true, isLocalMode: true })
  assert.strictEqual(p.update({ reachable: false, isLocalMode: true }), 'none')
})

test('a single dropped sample does not leave film mode', () => {
  // Bluetooth links drop in and out. Acting on one absent poll made film mode flap,
  // and every flap stops and restarts snapcast.
  const p: ProjectorPresence = new ProjectorPresence({ absentSamplesBeforeExit: 3 })
  p.update({ reachable: true, isLocalMode: false })            // auto-entered
  assert.strictEqual(p.update({ reachable: false, isLocalMode: true }), 'none', 'first miss')
  assert.strictEqual(p.update({ reachable: false, isLocalMode: true }), 'none', 'second miss')
})

test('a sustained absence does leave film mode', () => {
  const p: ProjectorPresence = new ProjectorPresence({ absentSamplesBeforeExit: 3 })
  p.update({ reachable: true, isLocalMode: false })
  p.update({ reachable: false, isLocalMode: true })
  p.update({ reachable: false, isLocalMode: true })
  assert.strictEqual(p.update({ reachable: false, isLocalMode: true }), 'exit')
})

test('the absence counter resets when the projector comes back', () => {
  const p: ProjectorPresence = new ProjectorPresence({ absentSamplesBeforeExit: 3 })
  p.update({ reachable: true, isLocalMode: false })
  p.update({ reachable: false, isLocalMode: true })
  p.update({ reachable: false, isLocalMode: true })
  p.update({ reachable: true, isLocalMode: true })             // flicker recovered
  assert.strictEqual(p.update({ reachable: false, isLocalMode: true }), 'none', 'counter restarted')
  assert.strictEqual(p.update({ reachable: false, isLocalMode: true }), 'none')
  assert.strictEqual(p.update({ reachable: false, isLocalMode: true }), 'exit')
})

console.log(failures === 0 ? '\nProjectorPresence: all tests passed' : `\nProjectorPresence: ${failures} test(s) failed`)
process.exit(failures === 0 ? 0 : 1)
