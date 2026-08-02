import { EventEmitter } from 'events'
import { exec } from 'child_process'
import * as fs from 'fs'
import { constants } from './constants'

declare interface BluetoothPairingButtonController {
  on(event: 'pairingRequested', listener: () => void): this
  emit(event: 'pairingRequested'): boolean
}

/**
 * Listens for a physical GPIO button press (or test-mode file trigger) and connects
 * to a configured Bluetooth device (e.g. projector) via BlueZ D-Bus.
 */
class BluetoothPairingButtonController extends EventEmitter {
  private lastButtonPress: number = 0
  private probeUnavailableLogged: boolean = false
  private readonly debounceDelay: number = 500 // ms
  private buttonPollInterval: NodeJS.Timeout | null = null
  private testModeInterval: NodeJS.Timeout | null = null

  constructor() {
    super()
    const { enabled, testMode, connectTo } = constants.bluetoothPairingButton
    if (enabled || testMode || connectTo) {
      this.initialize()
    }
  }

  private async initialize(): Promise<void> {
    const { enabled, testMode, buttonPin, hciInterface } = constants.bluetoothPairingButton

    if (testMode) {
      this.startTestModeWatcher()
    }

    if (enabled) {
      try {
        exec(`pinctrl set ${buttonPin} ip pu`, async (err) => {
          if (err) {
            console.error('[BluetoothPairingButton] Failed to configure GPIO:', err)
            return
          }
          let lastState = await this.readButton(buttonPin)
          this.buttonPollInterval = setInterval(async () => {
            const state = await this.readButton(buttonPin)
            if (state !== lastState) {
              if (state === 0) {
                const now = Date.now()
                if (now - this.lastButtonPress > this.debounceDelay) {
                  this.lastButtonPress = now
                  console.log('[BluetoothPairingButton] Button pressed - enabling pairing mode')
                  this.emit('pairingRequested')
                  this.enablePairingMode().catch((e) =>
                    console.error('[BluetoothPairingButton] Error enabling pairing:', e)
                  )
                }
              }
              lastState = state
            }
          }, 50)
          console.log(`[BluetoothPairingButton] Listening on GPIO ${buttonPin} (adapter ${hciInterface})`)
        })
      } catch (error) {
        console.error('[BluetoothPairingButton] Failed to initialize GPIO:', error)
      }
    }
  }

  private startTestModeWatcher(): void {
    const testFile = '/tmp/bluetooth-pairing'
    this.testModeInterval = setInterval(() => {
      try {
        if (fs.existsSync(testFile)) {
          fs.unlinkSync(testFile)
          console.log('[BluetoothPairingButton] Test trigger: enabling pairing mode')
          this.emit('pairingRequested')
          this.enablePairingMode().catch((e) =>
            console.error('[BluetoothPairingButton] Error enabling pairing:', e)
          )
        }
      } catch {
        // ignore
      }
    }, 1000)
    console.log('[BluetoothPairingButton] Test mode: touch /tmp/bluetooth-pairing to trigger pairing')
  }

  private readButton(pin: number): Promise<number> {
    return new Promise((resolve) => {
      exec(`pinctrl level ${pin}`, (err, stdout) => {
        if (err) resolve(1)
        else resolve(parseInt(stdout.trim(), 10))
      })
    })
  }

  /**
   * Initiate connection to a known device by MAC (e.g. your projector).
   * Device must already be paired. Uses bluetoothctl for compatibility across BlueZ versions.
   */
  private connectToDevice(mac: string): Promise<boolean> {
    const normalizedMac = mac.replace(/-/g, ':').toUpperCase()
    return new Promise((resolve) => {
      exec(`bluetoothctl connect ${normalizedMac}`, (err, stdout, stderr) => {
        // bluetoothctl exits 0 even when the connection fails, reporting the reason
        // on stdout instead. Trusting the exit code alone meant a switched-off or
        // simply wrong address was logged as a successful connection.
        const output: string = `${stdout ?? ''}${stderr ?? ''}`.trim()
        if (err || !/Connection successful/i.test(output)) {
          console.error(`[BluetoothPairingButton] Connect to ${normalizedMac} failed: ${output || err?.message || 'no confirmation from bluetoothctl'}`)
          resolve(false)
          return
        }
        console.log('[BluetoothPairingButton] Connected to', normalizedMac)
        resolve(true)
      })
    })
  }

  /** Everything bluetoothctl knows about, so a misconfigured address is visible. */
  public listDevices(): Promise<string> {
    return new Promise((resolve) => {
      exec('bluetoothctl devices', (err, stdout) => {
        if (err) {
          return resolve(`error: ${err.message}`)
        }
        exec('bluetoothctl paired-devices', (_e2, paired) => {
          resolve(`# known devices\n${stdout ?? ''}\n# paired devices\n${paired ?? ''}`)
        })
      })
    })
  }

  private disconnectFromDevice(mac: string): Promise<boolean> {
    const normalizedMac = mac.replace(/-/g, ':').toUpperCase()
    return new Promise((resolve) => {
      exec(`bluetoothctl disconnect ${normalizedMac}`, (err, _stdout, stderr) => {
        if (err) {
          console.error('[BluetoothPairingButton] Disconnect failed:', err.message)
          if (stderr) console.error('[BluetoothPairingButton]', stderr)
          resolve(false)
        } else {
          console.log('[BluetoothPairingButton] Disconnected from', normalizedMac)
          resolve(true)
        }
      })
    })
  }

  /**
   * Connect to the device configured in BLUETOOTH_PAIRING_CONNECT_TO (e.g. projector).
   * No-op if connectTo is not set.
   */
  /**
   * Is the projector powered on and in range? Deliberately passive: l2ping pokes the
   * link without opening an audio connection, so a device the user has manually
   * dropped out of film mode never gets reconnected behind their back, which would
   * push projector audio into the whole house.
   */
  public isProjectorReachable(): Promise<boolean> {
    const { connectTo } = constants.bluetoothPairingButton
    if (!connectTo) {
      return Promise.resolve(false)
    }

    const normalizedMac = connectTo.trim().toUpperCase()
    return new Promise((resolve) => {
      exec(`l2ping -c 1 -t 2 ${normalizedMac}`, (err: any) => {
        if (err && err.code === 127) {
          if (!this.probeUnavailableLogged) {
            this.probeUnavailableLogged = true
            console.log('[Bluetooth] l2ping not available; projector auto-detect disabled')
          }
          return resolve(false)
        }
        resolve(!err)
      })
    })
  }

  public async connectToProjector(): Promise<void> {
    const { connectTo } = constants.bluetoothPairingButton
    if (!connectTo) return
    await this.connectToDevice(connectTo)
  }

  /**
   * Disconnect from the device configured in BLUETOOTH_PAIRING_CONNECT_TO.
   * No-op if connectTo is not set.
   */
  public async disconnectFromProjector(): Promise<void> {
    const { connectTo } = constants.bluetoothPairingButton
    if (!connectTo) return
    await this.disconnectFromDevice(connectTo)
  }

  /**
   * Connect to the device configured in BLUETOOTH_PAIRING_CONNECT_TO (e.g. projector).
   * No-op if connectTo is not set. (Alias for API/test-mode trigger.)
   */
  public async enablePairingMode(): Promise<void> {
    await this.connectToProjector()
  }

  /**
   * Programmatic trigger (e.g. from API or test mode). Same as connect to projector.
   */
  public async triggerPairing(): Promise<void> {
    const { enabled, testMode, connectTo } = constants.bluetoothPairingButton
    if (!enabled && !testMode && !connectTo) {
      throw new Error('Bluetooth pairing button, test mode, or BLUETOOTH_PAIRING_CONNECT_TO is not set')
    }
    await this.connectToProjector()
  }

  public async cleanup(): Promise<void> {
    if (this.buttonPollInterval) {
      clearInterval(this.buttonPollInterval)
      this.buttonPollInterval = null
    }
    if (this.testModeInterval) {
      clearInterval(this.testModeInterval)
      this.testModeInterval = null
    }
  }
}

export default BluetoothPairingButtonController
