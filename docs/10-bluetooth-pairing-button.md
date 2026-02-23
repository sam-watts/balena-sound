# Bluetooth + Audio Mode (projector connect)

When **`BLUETOOTH_PAIRING_CONNECT_TO`** is set, the **audio mode toggle** button also controls Bluetooth: switch to **LOCAL** → connect to the projector; switch to **MULTIROOM** → disconnect. One button for both. No separate Bluetooth button needed.

## How it works

1. Set **`BLUETOOTH_PAIRING_CONNECT_TO`** to the **MAC address** of the device (e.g. projector).
2. The device must already be **paired** with balenaSound once (e.g. from the projector’s Bluetooth menu).
3. **Audio toggle button** (same as [audio mode toggle](09-audio-mode-toggle.md)):
   - Press → switch to **LOCAL** (audio to speakers) and **connect** to the projector.
   - Press again → switch to **MULTIROOM** and **disconnect** from the projector.

So: LOCAL = projector connected; MULTIROOM = projector disconnected.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `AUDIO_TOGGLE_ENABLED` | **Required for the button.** Enable the audio mode toggle (same button does Bluetooth when `CONNECT_TO` is set). | off |
| `BLUETOOTH_PAIRING_CONNECT_TO` | **MAC address** of device to connect to when switching to LOCAL (e.g. projector). Example: `AA:BB:CC:DD:EE:FF` | — |
| `BLUETOOTH_PAIRING_BUTTON_ENABLED` | Optional. Use a **second** physical button only for Bluetooth connect (same behaviour as LOCAL). | off |
| `BLUETOOTH_PAIRING_TEST_MODE` | Optional. Enable `touch /tmp/bluetooth-pairing` and `POST /bluetooth/pairing` to trigger connect. | off |
| `AUDIO_TOGGLE_BUTTON_PIN` | GPIO pin for the (single) audio/Bluetooth button. | 22 |
| `BLUETOOTH_HCI_INTERFACE` | Adapter name (must match bluetooth plugin if set). | hci0 |

**Minimal setup (one button):** set `AUDIO_TOGGLE_ENABLED=1` and `BLUETOOTH_PAIRING_CONNECT_TO=<projector MAC>`. Use the same button and pin as the audio mode toggle; no need for `BLUETOOTH_PAIRING_BUTTON_ENABLED`.

## Connect to projector (or other device)

1. **Pair the projector with balenaSound once** — From the **projector’s** Bluetooth menu, choose “Connect to Bluetooth speaker” (or similar) and select balenaSound.
2. **Get the projector’s MAC from the Pi** — On the device, run `bluetoothctl devices` and use the MAC for your projector.
3. **Set env vars** — `AUDIO_TOGGLE_ENABLED=1`, `BLUETOOTH_PAIRING_CONNECT_TO=AA:BB:CC:DD:EE:FF` (your projector’s MAC).
4. **Press the audio toggle button** — First press: LOCAL + connect to projector. Second press: MULTIROOM + disconnect.

## API

When `BLUETOOTH_PAIRING_CONNECT_TO` is set, a POST endpoint is available:

```bash
curl -X POST http://<device-ip>/bluetooth/pairing
```

This connects to the device (same as switching to LOCAL). It does not change audio mode.

## Requirements

- Bluetooth plugin enabled (not disabled via `SOUND_DISABLE_BLUETOOTH`).
- sound-supervisor with D-Bus and `bluez` (dbus, bluez in Dockerfile; `DBUS_SYSTEM_BUS_ADDRESS` in compose).
