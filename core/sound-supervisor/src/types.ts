export enum SoundModes {
  MULTI_ROOM = 'MULTI_ROOM',
  MULTI_ROOM_CLIENT = 'MULTI_ROOM_CLIENT',
  STANDALONE = "STANDALONE"
}

export enum AudioOutputMode {
  MULTIROOM = 'MULTIROOM',  // Audio goes through snapcast
  LOCAL = 'LOCAL'           // Audio goes directly to speakers
}