import * as cote from 'cote'
import BalenaAudio from 'balena-audio'
import SoundAPI from './SoundAPI'
import SoundConfig from './SoundConfig'
import AudioModeController from './AudioModeController'
import BluetoothPairingButtonController from './BluetoothPairingButtonController'
import MasterElection from './MasterElection'
import ProjectorPresence from './ProjectorPresence'
import { constants } from './constants'
import { getSdk } from 'balena-sdk'
import { startBalenaService, stopBalenaService } from './utils'
import { AudioOutputMode, SinkState } from './types'

// balenaSound core
const config: SoundConfig = new SoundConfig()
const audioBlock: BalenaAudio = new BalenaAudio(`tcp:${config.device.ip}:4317`)
const pairingButtonController = new BluetoothPairingButtonController()
const soundAPI: SoundAPI = new SoundAPI(config, audioBlock, pairingButtonController)
config.bindAudioBlock(audioBlock)

// AudioModeController will be initialized after audioBlock is ready
let audioModeController: AudioModeController

// Multi-room master election
const election: MasterElection = new MasterElection({
  claimCooldownMs: constants.multiroom.claimCooldown,
  acceptCooldownMs: constants.multiroom.acceptCooldown,
  deferToPlayingMasterMs: constants.multiroom.deferToPlayingMaster
})
// Film mode auto-detect. `switchingAutomatically` distinguishes our own mode changes
// from a button press, so a manual exit can suppress auto-entry while the projector
// is still sitting there powered on.
const projectorPresence: ProjectorPresence = new ProjectorPresence({
  absentSamplesBeforeExit: constants.audioToggle.projectorAbsentSamples
})
let switchingAutomatically: boolean = false
let probingProjector: boolean = false
let lastProjectorConnectAttempt: number = 0

let hasLocalPlayback: boolean = false
let wasPlaying: boolean = false
let reconciling: boolean = false

// Master election reads the input sink state over its own PulseAudio connection.
// Sharing the audio block's connection is not safe: that socket also carries the
// event subscription, and the client library drops a pending reply whenever a
// partial read arrives before a new packet header. After that every request on the
// socket times out forever, which is why this also rebuilds on repeated failure
// instead of logging the same timeout every few seconds.
let electionAudio: BalenaAudio | undefined
let electionFailures: number = 0

async function getElectionAudio(): Promise<BalenaAudio> {
  if (!electionAudio) {
    const audio: BalenaAudio = new BalenaAudio(`tcp:${config.device.ip}:4317`, false, 'BalenaSoundElection')
    await audio.listen()
    electionAudio = audio
  }
  return electionAudio
}

function dropElectionAudio(): void {
  try {
    (<any>electionAudio)?.socket?.destroy()
  } catch {
    // Socket already gone; we only care that the next reconcile reconnects.
  }
  electionAudio = undefined
}

// Film mode takes snapcast out of the audio path entirely: no snapclient buffer, no
// snapserver, and none of the CPU they cost competing with the audio thread. They
// have to come back on the way out, or the house loses multiroom until a restart.
function applyMultiRoomServices(running: boolean): void {
  if (!config.isMultiRoomEnabled()) {
    return
  }

  const apply = (service: string) => {
    const action = running ? startBalenaService : stopBalenaService
    action(service).catch((error: any) =>
      console.log(`Failed to ${running ? 'start' : 'stop'} ${service}: ${error?.message ?? error}`)
    )
  }

  if (config.isMultiRoomServer()) {
    apply('multiroom-server')
  }
  apply('multiroom-client')
}

async function pollProjector(): Promise<void> {
  if (probingProjector || !constants.bluetoothPairingButton.connectTo || !constants.audioToggle.autoFilmMode) {
    return
  }

  probingProjector = true
  let reachable: boolean
  try {
    // Cheap first: ask BlueZ whether it is already connected.
    reachable = await pairingButtonController.isProjectorConnected()

    // Nothing on the device reconnects a projector once it is powered on. It does
    // not initiate, and the bluetooth block only sweeps its paired devices at
    // startup and then gives up, so waiting passively means waiting forever. Reach
    // out and connect it, throttled because each attempt costs a few seconds, and
    // never while the user has overridden us by hand.
    const now: number = Date.now()
    if (!reachable && !projectorPresence.isSuppressed() && !audioModeController.isLocalMode()
        && now - lastProjectorConnectAttempt >= constants.audioToggle.projectorConnectInterval) {
      lastProjectorConnectAttempt = now
      reachable = await pairingButtonController.connectToProjector()
    }
  } finally {
    probingProjector = false
  }

  const action = projectorPresence.update({ reachable, isLocalMode: audioModeController.isLocalMode() })
  if (action === 'none') {
    return
  }

  const mode: AudioOutputMode = action === 'enter' ? AudioOutputMode.LOCAL : AudioOutputMode.MULTIROOM
  console.log(`Projector ${reachable ? 'detected' : 'gone'}, switching to ${mode}`)

  switchingAutomatically = true
  try {
    await audioModeController.requestMode(mode)
  } catch (error) {
    console.error('Projector auto-switch failed:', error)
  } finally {
    switchingAutomatically = false
  }
}

// Decide whether this device should be the multi-room master.
//
// This is deliberately level triggered rather than driven only by the audio block's
// 'play' event. That event fires on every PulseAudio sink change (balena-audio
// discards the event type), which produced a storm of master claims, and it is also
// missed when a source starts without one, which left audio playing on a device that
// no snapclient was listening to. Reading the input sink state answers the question
// directly: a null sink only reports RUNNING while something is feeding it.
async function reconcileMaster(): Promise<void> {
  if (reconciling || !config.isMultiRoomServer() || audioModeController?.isLocalMode()) {
    return
  }

  reconciling = true
  try {
    const audio: BalenaAudio = await getElectionAudio()
    const sink = await audio.getSink(constants.inputSink)
    hasLocalPlayback = sink.state === SinkState.RUNNING
    electionFailures = 0
  } catch (error) {
    electionFailures++
    // Report the first failure and then only occasionally, so a dead connection
    // doesn't fill the logs with one line every few seconds.
    if (electionFailures === 1 || electionFailures % 15 === 0) {
      console.log(`Master election: unable to read '${constants.inputSink}' (${electionFailures}x): ${error.message}`)
    }
    if (electionFailures >= 3) {
      console.log('Master election: reconnecting to the audio block')
      dropElectionAudio()
    }
    return
  } finally {
    reconciling = false
  }

  // Tell the fleet as soon as we stop playing, so a device waiting on us can take
  // over in seconds instead of waiting out its stand-down window or the next
  // fleet-sync heartbeat.
  if (wasPlaying && !hasLocalPlayback && config.isMultiRoomMaster()) {
    console.log(`Playback stopped on ${config.device.ip}, releasing multi-room master`)
    fleetPublisher.publish('fleet-update', { type: 'master', master: config.device.ip, playing: false })
  }
  wasPlaying = hasLocalPlayback

  if (election.shouldClaim({ selfIp: config.device.ip, isMaster: config.isMultiRoomMaster(), hasLocalPlayback })) {
    console.log(`Playback detected, announcing ${config.device.ip} as multi-room master!`)
    // Apply locally rather than waiting to receive our own broadcast back.
    config.setMultiRoomMaster(config.device.ip)
    fleetPublisher.publish('fleet-update', { type: 'master', master: config.device.ip, playing: true })
  }
}

// init balenaCloud sdk
const sdk = getSdk({ apiUrl: 'https://api.balena-cloud.com/' })
sdk.auth.logout()
sdk.auth.loginWithToken(process.env.BALENA_API_KEY!) // Asserted by io.balena.features.balena-api: '1'

// Fleet communication
let discoveryOptions: any = {
  log: false,
  helloLogsEnabled: false,
  statusLogsEnabled: false
}
const fleetPublisher: cote.Publisher = new cote.Publisher({ name: 'balenaSound publisher' }, discoveryOptions)
const fleetSubscriber: cote.Subscriber = new cote.Subscriber({ name: 'balenaSound subscriber' }, discoveryOptions)

init()
async function init() {
  await soundAPI.listen(constants.port)
  await audioBlock.listen()
  await audioBlock.setVolume(constants.volume)

  // Initialize AudioModeController after audio block is ready. It owns the button,
  // the LED and the mode; the audio container owns the routing.
  audioModeController = new AudioModeController({
    onPrepareLocal:
      constants.bluetoothPairingButton.connectTo
        ? async () => { await pairingButtonController.connectToProjector() }
        : undefined,
  })

  // If the supervisor restarted while multiroom was stopped for film mode, nothing
  // else would ever start it again. Reconcile from our own mode rather than trusting
  // whatever service state was left behind.
  if (!audioModeController.isLocalMode()) {
    applyMultiRoomServices(true)
  }

  soundAPI.setAudioOutputModeGetter(() =>
    audioModeController.getCurrentMode() === AudioOutputMode.LOCAL ? 'LOCAL' : 'MULTIROOM'
  )

  // Sync Bluetooth with initial mode (e.g. after restart we might already be LOCAL)
  if (audioModeController.getCurrentMode() === AudioOutputMode.LOCAL && constants.bluetoothPairingButton.connectTo) {
    pairingButtonController.connectToProjector().catch((e) =>
      console.error('[Bluetooth] Connect on startup (LOCAL) failed:', e)
    )
  }

  // Set up event handlers for AudioModeController
  audioModeController.on('modeChanged', async (mode: AudioOutputMode) => {
    console.log(`Audio output mode changed to: ${mode}`)

    if (!switchingAutomatically) {
      projectorPresence.noteManualToggle(mode === AudioOutputMode.LOCAL)
    }

    if (mode === AudioOutputMode.LOCAL) {
      console.log('Local mode active: stopping multiroom so films get the shortest path')
      applyMultiRoomServices(false)
    } else {
      console.log('Multiroom mode active: Snapcast coordination enabled')
      applyMultiRoomServices(true)
      if (constants.bluetoothPairingButton.connectTo) {
        pairingButtonController.disconnectFromProjector().catch((e) =>
          console.error('[Bluetooth] Disconnect on MULTIROOM switch failed:', e)
        )
      }
      // If we're switching back to multiroom and we're the master, announce ourselves
      if (config.isMultiRoomMaster()) {
        fleetPublisher.publish('fleet-update', { type: 'master', master: config.multiroom.master, playing: hasLocalPlayback })
      }
    }
  })

  // For multi room, allow cote to establish connections before sending fleet-sync
  if (config.isMultiRoomEnabled()) {
    await timeout(constants.coteDelay)
    console.log('Joining the fleet, requesting master info with fleet-sync...')
    fleetPublisher.publish('fleet-sync', { type: 'sync', origin: config.device.ip })
  }

  // Periodically sync the fleet
  setInterval(() => {
    if (config.isMultiRoomEnabled()) {
      fleetPublisher.publish('fleet-sync', { type: 'sync', origin: config.device.ip })
    }
  }, constants.multiroom.pollInterval)

  // Periodically re-check whether we should be master, so a device that starts
  // playing always takes over even if its 'play' event never arrived
  setInterval(() => { void reconcileMaster() }, constants.multiroom.electionInterval)

  // Watch for the projector powering on so films start without touching the button
  if (constants.bluetoothPairingButton.connectTo && constants.audioToggle.autoFilmMode) {
    console.log(`Watching for projector ${constants.bluetoothPairingButton.connectTo} to start film mode automatically`)
    setInterval(() => { void pollProjector() }, constants.audioToggle.projectorPollInterval)
  }
}

// Event: "play"
// Source: audio block
// On audio playback, set this server as the multiroom-master
// We check the input sink that receives all audio sources
// However, if we're in LOCAL mode, we skip multiroom coordination
audioBlock.on('play', async (sink: any) => {
  if (constants.debug) {
    console.log(`[event] Audio block: play`)
    console.log(sink)
  }

  // Respond quickly to playback starting, rather than waiting for the next
  // reconcile. reconcileMaster() re-checks every guard and rate limits itself.
  if (sink.name === constants.inputSink) {
    void reconcileMaster()
  }

  // Temporary usage tracking for balenaHub metrics
  try {
    await sdk.models.device.tags.set(process.env.BALENA_DEVICE_UUID!, 'metrics:play', '') // BALENA_DEVICE_UUID is always present in balenaOS
  } catch (error) {
    console.log(error.message)
  }

})

// Event: "fleet-update"
// Source: fleet
// If the master server changed, reset multiroom-client service
fleetSubscriber.on('fleet-update', async (data: any) => {
  if (constants.debug) {
    console.log(`[event] fleet: fleet-update`)
    console.log(data)
  }

  const claimantPlaying: boolean = data.playing === true

  const accepted: boolean = election.shouldAccept({
    claimant: data.master,
    // Absent on a re-assert from a device that isn't producing audio, and on any
    // peer still running an older build. Treated as "not playing" either way, so
    // we never hand master to a device we can't confirm has audio.
    claimantPlaying,
    selfIp: config.device.ip,
    isNewMaster: config.isNewMultiRoomMaster(data.master),
    isMaster: config.isMultiRoomMaster(),
    hasLocalPlayback,
    locked: config.multiroom.forced || constants.multiroom.disallowUpdates
  })

  if (accepted) {
    console.log(`Multi-room master has changed to ${data.master}, restarting snapcast-client...`)
    config.setMultiRoomMaster(data.master)
  }

  // Stand down while a device that is actually producing audio holds master,
  // whether we just yielded to it or it is re-asserting itself. Only once it is
  // genuinely our master: if we rejected the claim because we are the one playing,
  // config.multiroom.master is still us and we keep competing.
  if (data.master !== config.device.ip && config.multiroom.master === data.master) {
    if (claimantPlaying) {
      election.deferTo(data.master)
    } else {
      // It has gone quiet, so stop standing down and let this device take over as
      // soon as it has something to play, rather than waiting out the window.
      election.clearDefer()
    }
  }
})

// Event: "fleet-sync"
// Source: fleet
// When it receives this event the multiroom master announces itself as the master
// This happens when a new device joines the fleet but also periodically
fleetSubscriber.on('fleet-sync', (data: any) => {
  if (constants.debug) {
    console.log(`[event] fleet: fleet-sync`)
    console.log(data)
  }

  if (config.isMultiRoomMaster() && data.origin !== config.device.ip) {
    // Carry whether we're actually producing audio, so a peer that is playing
    // doesn't hand master back to us while we sit silent.
    fleetPublisher.publish('fleet-update', { type: 'master', master: config.multiroom.master, playing: hasLocalPlayback })
  }
})


// Cleanup on exit
async function cleanup(): Promise<void> {
  console.log('Shutting down...')
  if (audioModeController) await audioModeController.cleanup()
  if (
    constants.bluetoothPairingButton.enabled ||
    constants.bluetoothPairingButton.testMode ||
    constants.bluetoothPairingButton.connectTo
  ) {
    await pairingButtonController.cleanup()
  }
  process.exit(0)
}

process.on('SIGINT', () => cleanup())
process.on('SIGTERM', () => cleanup())

async function timeout(delay: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delay))
}