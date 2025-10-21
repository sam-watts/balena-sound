# Audio Mode Toggle Feature

This feature allows balenaSound to toggle between two audio output modes:

1. **MULTIROOM mode** (default): Audio goes through snapcast for multi-room synchronization
2. **LOCAL mode**: Audio goes directly to the speakers/output device

## Configuration

Enable the audio toggle feature by setting these environment variables:

### Required
- `AUDIO_TOGGLE_ENABLED=1` - Enable the audio toggle feature

### Optional
- `AUDIO_TOGGLE_TEST_MODE=1` - Enable test mode for CLI control (default: false)
- `AUDIO_TOGGLE_BUTTON_PIN=17` - GPIO pin for the toggle button (default: 17)
- `AUDIO_TOGGLE_SNAPCAST_SINK_ID=3` - PulseAudio sink ID for snapcast (default: 3)
- `AUDIO_TOGGLE_LOCAL_SINK_ID=0` - PulseAudio sink ID for direct hardware output (default: 0)

## Hardware Setup

### GPIO Connections
- **Button**: Connect a momentary push button between GPIO pin 17 (configurable) and ground

The button can be a simple momentary push button or one with an integrated LED that handles its own status indication.

## Usage

### Hardware Mode
1. Set `AUDIO_TOGGLE_ENABLED=1`
2. Connect hardware as described above
3. Press the button to toggle between modes

### Test Mode (CLI)
1. Set `AUDIO_TOGGLE_ENABLED=1` and `AUDIO_TOGGLE_TEST_MODE=1`
2. Use these commands from any shell:
   - Toggle mode: `touch /tmp/audio-toggle`
   - Set LOCAL mode: `touch /tmp/audio-local`
   - Set MULTIROOM mode: `touch /tmp/audio-multiroom`
   - Show current mode: `touch /tmp/audio-status`

## How It Works

When in LOCAL mode:
- All PulseAudio sink inputs are moved to the hardware output sink (bypassing balenaSound processing)
- Multiroom coordination is disabled
- Audio plays directly through the hardware with minimal latency

When in MULTIROOM mode:
- All PulseAudio sink inputs are moved to the snapcast sink
- Normal multiroom coordination resumes
- Audio is distributed via snapcast with the usual balenaSound processing

## Sink Discovery

To find the correct sink IDs for your system, you can check the logs when the sound-supervisor starts, or use the support endpoint:

```bash
# Get audio system info
curl http://localhost/support

# Look for the "sinks" section to see available sink IDs
```

The default configuration assumes:
- Sink ID 0: Hardware audio output (direct to speakers/DAC - lowest latency)
- Sink ID 3: `snapcast` (multiroom distribution)

Update the environment variables if your system uses different sink IDs.
