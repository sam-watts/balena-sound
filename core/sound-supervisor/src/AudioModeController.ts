import { EventEmitter } from 'events'
import { AudioOutputMode } from './types'
import { constants } from './constants'
import * as fs from 'fs'
import { exec } from 'child_process'

declare interface AudioModeController {
    on(event: 'modeChanged', listener: (mode: AudioOutputMode) => void): this;
    emit(event: 'modeChanged', mode: AudioOutputMode): boolean;
}

class AudioModeController extends EventEmitter {
    private currentMode: AudioOutputMode = AudioOutputMode.MULTIROOM
    private lastButtonPress: number = 0
    private readonly debounceDelay: number = 300 // ms
    private buttonPollInterval: NodeJS.Timeout | null = null
    private ledPulseInterval: NodeJS.Timeout | null = null
    private onPrepareLocal?: () => Promise<void>

    constructor(options?: { onPrepareLocal?: () => Promise<void> }) {
        super()
        this.onPrepareLocal = options?.onPrepareLocal
        if (constants.audioToggle.enabled) {
            this.initialize()
        }
    }

    private async initialize(): Promise<void> {
        if (constants.audioToggle.testMode) {
            console.log('Audio mode toggle: Running in TEST MODE. Type "t" + Enter to toggle, "q" to quit.')
            this.initializeTestMode()
        } else {
            try {
                exec(`pinctrl set ${constants.audioToggle.ledPin} op`)
                // flash led 3 times to test
                for (let i = 0; i < 3; i++) {
                    await this.setLed(true)
                    await this.delay(100)
                    await this.setLed(false)
                    await this.delay(100)
                }
                await this.initializeGPIOMode()
            } catch (error) {
                console.error('Failed to initialize GPIO:', error)
                this.initializeTestMode()
            }
        }
        // Set initial mode
        await this.setMode(this.currentMode)
    }

    private initializeTestMode(): void {
        console.log('Audio mode toggle: Running in TEST MODE.')
        console.log('Control commands:')
        console.log('  - Toggle mode: touch /tmp/audio-toggle')
        console.log('  - Set LOCAL mode: touch /tmp/audio-local')
        console.log('  - Set MULTIROOM mode: touch /tmp/audio-multiroom')
        console.log('  - Show current mode: touch /tmp/audio-status')

        // Monitor test files for mode changes

        const checkTestFiles = () => {
            const toggleFile = '/tmp/audio-toggle'
            const localFile = '/tmp/audio-local'
            const multiroomFile = '/tmp/audio-multiroom'
            const statusFile = '/tmp/audio-status'

            try {
                if (fs.existsSync(toggleFile)) {
                    fs.unlinkSync(toggleFile)
                    console.log('Test command received: toggle mode')
                    this.toggleMode().catch(error => console.error('Error toggling mode:', error))
                } else if (fs.existsSync(localFile)) {
                    fs.unlinkSync(localFile)
                    console.log('Test command received: set LOCAL mode')
                    this.setMode(AudioOutputMode.LOCAL).catch(error => console.error('Error setting LOCAL mode:', error))
                } else if (fs.existsSync(multiroomFile)) {
                    fs.unlinkSync(multiroomFile)
                    console.log('Test command received: set MULTIROOM mode')
                    this.setMode(AudioOutputMode.MULTIROOM).catch(error => console.error('Error setting MULTIROOM mode:', error))
                } else if (fs.existsSync(statusFile)) {
                    fs.unlinkSync(statusFile)
                    console.log(`Current audio mode: ${this.currentMode}`)
                }
            } catch (error) {
                // Ignore file system errors in test mode
            }
        }

        // Check for test files every 1 second
        setInterval(checkTestFiles, 1000)
    }

    private async initializeGPIOMode(): Promise<void> {
        const buttonPin = constants.audioToggle.buttonPin
        exec(`pinctrl set ${buttonPin} ip pu`)
        // Poll for button events
        let lastState = await this.readButton(buttonPin)
        this.buttonPollInterval = setInterval(async () => {
            const state = await this.readButton(buttonPin)
            if (state !== lastState) {
                const timestamp = new Date().toISOString()
                const level = state
                console.log(`[BUTTON] ${timestamp} State changed: level=${level} (0=pressed, 1=released)`)
                if (level === 0) { // Button pressed (connected to ground)
                    const now = Date.now()
                    const timeSinceLastPress = now - this.lastButtonPress
                    console.log(`[BUTTON] Time since last press: ${timeSinceLastPress}ms (debounce: ${this.debounceDelay}ms)`)
                    if (timeSinceLastPress > this.debounceDelay) {
                        this.lastButtonPress = now
                        console.log('[BUTTON] Press debounced - toggling audio mode')
                        this.toggleMode().catch(error => console.error('[BUTTON] Error toggling mode:', error))
                    } else {
                        console.log('[BUTTON] Press ignored - within debounce period')
                    }
                } else {
                    console.log('[BUTTON] Button released')
                }
                lastState = state
            }
        }, 50)
        console.log('[BUTTON] Polling active - ready for button presses')
    }

    private readButton(pin: number): Promise<number> {
        return new Promise((resolve) => {
            exec(`pinctrl level ${pin}`, (err, stdout) => {
                if (err) {
                    console.error('Error reading button pin:', err)
                    resolve(1) // default to not pressed
                } else {
                    resolve(parseInt(stdout.trim(), 10))
                }
            })
        })
    }

    private async setLed(on: boolean): Promise<void> {
        const ledPin = constants.audioToggle.ledPin
        return new Promise((resolve) => {
            const cmd = on ? `pinctrl set ${ledPin} dh` : `pinctrl set ${ledPin} dl`
            exec(cmd, (err) => {
                if (err) {
                    console.error('Failed to set LED state:', err)
                }
                resolve()
            })
        })
    }

    private startLedPulse(): void {
        this.stopLedPulse()
        let ledOn = false
        this.ledPulseInterval = setInterval(() => {
            ledOn = !ledOn
            this.setLed(ledOn)
        }, 250) // 250ms on, 250ms off = 2 pulses per second
    }

    private stopLedPulse(): void {
        if (this.ledPulseInterval) {
            clearInterval(this.ledPulseInterval)
            this.ledPulseInterval = null
        }
    }

    // Owns the button, the LED and which mode we are in. Nothing here touches
    // PulseAudio: apply-output-mode-latency.sh in the audio container is the single
    // owner of the routing. Two components rewiring the same graph on different
    // models of it is what made every mode switch click.
    private async setMode(mode: AudioOutputMode): Promise<void> {
        this.currentMode = mode

        // Pulse LED while switching to give immediate feedback
        this.startLedPulse()

        try {
            if (mode === AudioOutputMode.LOCAL) {
                console.log('>>> Switching to LOCAL mode (film: source -> speakers directly)')
                // Connect the projector before announcing the mode, so the stream
                // exists by the time the audio container reroutes to hardware.
                if (this.onPrepareLocal) {
                    await this.onPrepareLocal()
                }
                this.stopLedPulse()
                this.setLed(true)
            } else {
                console.log('>>> Switching to MULTIROOM mode (audio -> snapcast)')
                this.stopLedPulse()
                this.setLed(false)
            }
        } catch (error) {
            this.stopLedPulse()
            this.setLed(false)
            throw error
        }

        // Emit event for other components to react
        this.emit('modeChanged', mode)
    }

    public async toggleMode(): Promise<void> {
        const newMode = this.currentMode === AudioOutputMode.MULTIROOM
            ? AudioOutputMode.LOCAL
            : AudioOutputMode.MULTIROOM
        await this.setMode(newMode)
    }

    public getCurrentMode(): AudioOutputMode {
        return this.currentMode
    }

    public isLocalMode(): boolean {
        return this.currentMode === AudioOutputMode.LOCAL
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    public async cleanup(): Promise<void> {
        this.stopLedPulse()
        if (this.buttonPollInterval) {
            clearInterval(this.buttonPollInterval)
            this.buttonPollInterval = null
            console.log('Button polling cleanup completed')
        }
        // Optionally turn off LED
        await this.setLed(false)
    }
}

export default AudioModeController
