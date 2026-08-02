export type PresenceAction = 'enter' | 'exit' | 'none'

export interface PresenceInputs {
  reachable: boolean,
  isLocalMode: boolean
}

export interface PresenceOptions {
  // Consecutive absent samples before believing the projector has really gone.
  absentSamplesBeforeExit?: number
}

// Turns a stream of "can we see the projector" samples into film mode transitions.
//
// Kept separate from the polling and the Bluetooth calls so the awkward parts are
// testable: the projector appearing while we are already in film mode, the user
// overriding by hand, and the projector disappearing again.
export default class ProjectorPresence {
  private reachable: boolean = false
  private suppressed: boolean = false
  private enteredAutomatically: boolean = false
  private absentSamples: number = 0
  private readonly absentSamplesBeforeExit: number

  constructor(options: PresenceOptions = {}) {
    this.absentSamplesBeforeExit = options.absentSamplesBeforeExit ?? 3
  }

  // The button was pressed. Leaving film mode by hand while the projector is still
  // sitting there has to stick, otherwise the next poll drags us straight back in
  // and the button appears to do nothing. The override lasts until the projector
  // goes away, so turning it off and on again is enough to re-arm.
  noteManualToggle(isLocalMode: boolean): void {
    this.suppressed = !isLocalMode && this.reachable
    this.enteredAutomatically = false
  }

  // True while the user has overridden us by hand. Callers use this to skip the
  // active connection attempt, so an override does not keep dragging the projector
  // back on to the Pi and pushing its audio into the whole house.
  isSuppressed(): boolean {
    return this.suppressed
  }

  update({ reachable, isLocalMode }: PresenceInputs): PresenceAction {
    this.reachable = reachable

    if (!reachable) {
      // A Bluetooth link drops in and out on its own. Acting on a single absent
      // sample made film mode flap, and every flap stops and restarts snapcast, so
      // wait for the projector to stay gone before believing it.
      this.absentSamples++
      if (this.absentSamples < this.absentSamplesBeforeExit) {
        return 'none'
      }

      // Projector gone: any manual override has served its purpose.
      this.suppressed = false

      // Only undo a switch we made ourselves. If the user chose film mode by hand,
      // losing sight of the projector should not yank them out of it.
      if (isLocalMode && this.enteredAutomatically) {
        this.enteredAutomatically = false
        return 'exit'
      }
      return 'none'
    }

    this.absentSamples = 0

    if (!isLocalMode && !this.suppressed) {
      this.enteredAutomatically = true
      return 'enter'
    }

    return 'none'
  }
}
