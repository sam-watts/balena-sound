import * as cote from 'cote'
import BalenaAudio from 'balena-audio'
import SoundAPI from './SoundAPI'
import SoundConfig from './SoundConfig'
import AudioModeController from './AudioModeController'
import BluetoothPairingButtonController from './BluetoothPairingButtonController'
import MasterElection from './MasterElection'
import { constants } from './constants'
import { getSdk } from 'balena-sdk'
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
  acceptCooldownMs: constants.multiroom.acceptCooldown
})
let hasLocalPlayback: boolean = false
let reconciling: boolean = false

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
    const sink = await audioBlock.getSink(constants.inputSink)
    hasLocalPlayback = sink.state === SinkState.RUNNING
  } catch (error) {
    console.log(`Master election: unable to read '${constants.inputSink}': ${error.message}`)
    return
  } finally {
    reconciling = false
  }

  if (election.shouldClaim({ isMaster: config.isMultiRoomMaster(), hasLocalPlayback })) {
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

  // Initialize AudioModeController after audio block is ready.
  // When switching to LOCAL, connect to projector first (await), then switch sink so audio flows as soon as sink moves.
  audioModeController = new AudioModeController(audioBlock, {
    onPrepareLocal:
      constants.bluetoothPairingButton.connectTo
        ? () => pairingButtonController.connectToProjector()
        : undefined,
  })

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

    if (mode === AudioOutputMode.LOCAL) {
      console.log('Local mode active: Multiroom coordination disabled')
    } else {
      console.log('Multiroom mode active: Snapcast coordination enabled')
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

  const accepted: boolean = election.shouldAccept({
    claimant: data.master,
    // Absent on a re-assert from a device that isn't producing audio, and on any
    // peer still running an older build. Treated as "not playing" either way, so
    // we never hand master to a device we can't confirm has audio.
    claimantPlaying: data.playing === true,
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