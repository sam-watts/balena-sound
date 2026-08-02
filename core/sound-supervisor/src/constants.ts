import { SoundModes } from "./types"

function checkInt(s: string | undefined): number | undefined {
  return s ? parseInt(s) : undefined
}

function checkBool(s: string | undefined): boolean {
  return s === '1' || s?.toLowerCase() === 'true'
}

let deviceType: string = process.env.BALENA_DEVICE_TYPE ?? 'unknown'

export function defaultMode(): SoundModes {
  return ['raspberry-pi', 'raspberry-pi2', 'unknown'].includes(deviceType) ? SoundModes.STANDALONE : SoundModes.MULTI_ROOM
}

export const constants = {
  debug: process.env.SOUND_SUPERVISOR_DEBUG ? true : false,
  port: checkInt(process.env.SOUND_SUPERVISOR_PORT) ?? 80,
  coteDelay: checkInt(process.env.SOUND_COTE_DELAY) ?? 5000,
  mode: (<SoundModes>process.env.SOUND_MODE) ?? defaultMode(),
  balenaDeviceType: deviceType,
  multiroom: {
    master: process.env.SOUND_MULTIROOM_MASTER,
    forced: process.env.SOUND_MULTIROOM_MASTER ? true : false,
    pollInterval: (checkInt(process.env.SOUND_MULTIROOM_POLL_INTERVAL) ?? 60) * 1000,
    disallowUpdates: process.env.SOUND_MULTIROOM_DISALLOW_UPDATES ? true : false,
    // How often to re-check whether this device should be master. The 'play' event
    // is unreliable on its own, so election is reconciled on this interval too.
    electionInterval: (checkInt(process.env.SOUND_MULTIROOM_ELECTION_INTERVAL) ?? 4) * 1000,
    // Minimum gap between announcing ourselves as master, and between acting on
    // another device's announcement. Each acceptance restarts the snapclient.
    claimCooldown: (checkInt(process.env.SOUND_MULTIROOM_CLAIM_COOLDOWN) ?? 15) * 1000,
    acceptCooldown: (checkInt(process.env.SOUND_MULTIROOM_ACCEPT_COOLDOWN) ?? 15) * 1000
  },
  volume: checkInt(process.env.SOUND_VOLUME) ?? 75,
  inputSink: process.env.SOUND_INPUT_SINK ?? 'balena-sound.input',
  audioToggle: {
    enabled: checkBool(process.env.AUDIO_TOGGLE_ENABLED),
    testMode: checkBool(process.env.AUDIO_TOGGLE_TEST_MODE),
    buttonPin: checkInt(process.env.AUDIO_TOGGLE_BUTTON_PIN) ?? 22,
    ledPin: checkInt(process.env.AUDIO_TOGGLE_LED_PIN) ?? 17,
    snapcastSinkId: checkInt(process.env.AUDIO_TOGGLE_SNAPCAST_SINK_ID) ?? 3,
    localSinkId: checkInt(process.env.AUDIO_TOGGLE_LOCAL_SINK_ID) ?? 0,
  },
  bluetoothPairingButton: {
    enabled: checkBool(process.env.BLUETOOTH_PAIRING_BUTTON_ENABLED),
    testMode: checkBool(process.env.BLUETOOTH_PAIRING_TEST_MODE),
    buttonPin: checkInt(process.env.BLUETOOTH_PAIRING_BUTTON_PIN) ?? 27,
    hciInterface: process.env.BLUETOOTH_HCI_INTERFACE ?? 'hci0',
    /** If set (e.g. AA:BB:CC:DD:EE:FF), button press will connect TO this device (e.g. your projector). Device must already be paired. */
    connectTo: process.env.BLUETOOTH_PAIRING_CONNECT_TO?.trim() || undefined,
  }
}

