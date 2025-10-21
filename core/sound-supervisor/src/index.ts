import * as cote from 'cote'
import BalenaAudio from 'balena-audio'
import SoundAPI from './SoundAPI'
import SoundConfig from './SoundConfig'
import AudioModeController from './AudioModeController'
import { constants } from './constants'
import { getSdk } from 'balena-sdk'
import { AudioOutputMode } from './types'

// balenaSound core
const config: SoundConfig = new SoundConfig()
const audioBlock: BalenaAudio = new BalenaAudio(`tcp:${config.device.ip}:4317`)
const soundAPI: SoundAPI = new SoundAPI(config, audioBlock)
config.bindAudioBlock(audioBlock)

// AudioModeController will be initialized after audioBlock is ready
let audioModeController: AudioModeController

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

  // Initialize AudioModeController after audio block is ready
  audioModeController = new AudioModeController(audioBlock)

  // Set up event handlers for AudioModeController
  audioModeController.on('modeChanged', (mode: AudioOutputMode) => {
    console.log(`Audio output mode changed to: ${mode}`)

    if (mode === AudioOutputMode.LOCAL) {
      console.log('Local mode active: Multiroom coordination disabled')
    } else {
      console.log('Multiroom mode active: Snapcast coordination enabled')
      // If we're switching back to multiroom and we're the master, announce ourselves
      if (config.isMultiRoomMaster()) {
        fleetPublisher.publish('fleet-update', { type: 'master', master: config.multiroom.master })
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

  // Only handle multiroom coordination if we're not in local mode
  if (config.isMultiRoomServer() && sink.name === constants.inputSink && !audioModeController.isLocalMode()) {
    console.log(`Playback started, announcing ${config.device.ip} as multi-room master!`)
    fleetPublisher.publish('fleet-update', { type: 'master', master: config.device.ip })
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

  if (config.isNewMultiRoomMaster(data.master) && !config.multiroom.forced && !constants.multiroom.disallowUpdates) {
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
    fleetPublisher.publish('fleet-update', { type: 'master', master: config.multiroom.master })
  }
})


// Cleanup on exit
process.on('SIGINT', () => {
  console.log('Shutting down...')
  audioModeController.cleanup()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('Shutting down...')
  audioModeController.cleanup()
  process.exit(0)
})

async function timeout(delay: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delay))
}