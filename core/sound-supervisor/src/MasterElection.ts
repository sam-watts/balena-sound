export interface ClaimInputs {
  isMaster: boolean,
  hasLocalPlayback: boolean
}

export interface ElectionOptions {
  claimCooldownMs?: number,
  acceptCooldownMs?: number,
  deferToPlayingMasterMs?: number,
  now?: () => number
}

export interface AcceptInputs {
  claimant: string,
  claimantPlaying: boolean,
  selfIp: string,
  isNewMaster: boolean,
  isMaster: boolean,
  hasLocalPlayback: boolean,
  locked: boolean
}

// Decides when this device should claim multi-room master, and when it should
// accept a claim broadcast by another device.
//
// This guards two failures seen in production:
//
//  - Claim storms. balena-audio emits 'play' on every PulseAudio sink change
//    because it discards the event type, so a device with an active input sink
//    re-announced itself continuously and every announcement restarted the peer's
//    snapclient (an audible dropout). Claims are rate limited, and a device that
//    already holds master never re-claims.
//
//  - Stranded audio. Election used to be purely edge triggered, so a device that
//    started playing without emitting a sink event never claimed master, and its
//    audio reached no snapclient at all. Callers reconcile on a timer instead, and
//    a device that is actually playing will not surrender master to an idle peer.
export default class MasterElection {
  private lastClaimAt: number = 0
  private lastAcceptAt: number = 0
  private deferUntil: number = 0
  private readonly claimCooldownMs: number
  private readonly acceptCooldownMs: number
  private readonly deferToPlayingMasterMs: number
  private readonly now: () => number

  constructor(options: ElectionOptions = {}) {
    this.claimCooldownMs = options.claimCooldownMs ?? 15000
    this.acceptCooldownMs = options.acceptCooldownMs ?? 15000
    this.deferToPlayingMasterMs = options.deferToPlayingMasterMs ?? 90000
    this.now = options.now ?? (() => Date.now())
  }

  // Another device that is producing audio holds master. Stand down until this
  // expires, refreshed every time that device re-asserts itself while still
  // playing. Without this a device whose input sink is permanently RUNNING (a
  // soundcard input loops a capture device straight into it, so it never goes
  // idle) re-claims master the instant it yields, and the two ping-pong on every
  // fleet sync, restarting a snapclient each time.
  deferTo(): void {
    this.deferUntil = this.now() + this.deferToPlayingMasterMs
  }

  isDeferring(): boolean {
    return this.now() < this.deferUntil
  }

  // The master has told us it stopped playing, so there is nothing left to defer
  // to and we can take over immediately rather than waiting out the window.
  clearDefer(): void {
    this.deferUntil = 0
  }

  // Should we broadcast ourselves as master? Only when we are producing audio,
  // aren't already master, aren't standing down for a playing peer, and at most
  // once per cooldown.
  shouldClaim({ isMaster, hasLocalPlayback }: ClaimInputs): boolean {
    if (isMaster || !hasLocalPlayback || this.isDeferring()) {
      return false
    }

    const now: number = this.now()
    if (now - this.lastClaimAt < this.claimCooldownMs) {
      return false
    }

    this.lastClaimAt = now
    return true
  }

  // Should we act on another device's claim? Accepting restarts our snapclient, so
  // this is rate limited too.
  shouldAccept({ claimant, claimantPlaying, selfIp, isNewMaster, isMaster, hasLocalPlayback, locked }: AcceptInputs): boolean {
    if (!isNewMaster || locked) {
      return false
    }

    // We hold master and we are the device actually producing audio. Never hand
    // master to an idle device, or its snapserver becomes a silent one that every
    // snapclient is listening to. Stand aside only for a device that is also
    // playing and wins the tie break, otherwise the two bounce master forever.
    if (isMaster && hasLocalPlayback && (!claimantPlaying || !winsTieBreak(claimant, selfIp))) {
      return false
    }

    const now: number = this.now()
    if (now - this.lastAcceptAt < this.acceptCooldownMs) {
      return false
    }

    this.lastAcceptAt = now
    return true
  }
}

// Lowest address wins, so two devices playing at once settle on the same master
// rather than flapping. Ranked numerically because '192.168.0.155' sorts before
// '192.168.0.80' as a string, which would pick the wrong winner.
export function winsTieBreak(claimant: string, selfIp: string): boolean {
  return ipRank(claimant) < ipRank(selfIp)
}

function ipRank(ip: string): number {
  return ip.split('.').reduce((rank, octet) => (rank * 256) + (parseInt(octet, 10) || 0), 0)
}
