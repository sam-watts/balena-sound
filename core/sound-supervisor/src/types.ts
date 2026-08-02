export enum SoundModes {
  MULTI_ROOM = 'MULTI_ROOM',
  MULTI_ROOM_CLIENT = 'MULTI_ROOM_CLIENT',
  STANDALONE = "STANDALONE"
}

export enum AudioOutputMode {
  MULTIROOM = 'MULTIROOM',  // Audio goes through snapcast
  LOCAL = 'LOCAL'           // Audio goes directly to speakers
}

// PulseAudio pa_sink_state_t. A null sink only reports RUNNING while a source is
// actively feeding it, so the state of 'balena-sound.input' tells us whether this
// device is the one currently producing audio.
export enum SinkState {
  RUNNING = 0,
  IDLE = 1,
  SUSPENDED = 2
}