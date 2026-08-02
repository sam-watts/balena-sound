#!/bin/bash
# Apply audio routing for the supervisor's audio output mode. Polled by start.sh.
#
#   LOCAL     film mode. Real source streams go straight to the hardware sink with
#             no loopbacks in the path, for the lowest latency we can manage.
#   MULTIROOM normal operation: sources feed balena-sound.input, loopbacks carry
#             audio on to snapcast and to the hardware.
#
# This script is the ONLY thing that rewires the PulseAudio graph. AudioModeController
# used to move sink inputs too, on a different model of the graph, and the two fought
# each other on every poll: that is what made mode switches click. The supervisor now
# owns the button, the LED and the mode; everything below owns the routing.
#
# Everything here resolves sinks by NAME. Sink and sink-input indexes shift as
# streams and cards come and go, so the old numeric assumptions broke as soon as a
# Bluetooth device reconnected.

SOUND_SUPERVISOR_PORT=${SOUND_SUPERVISOR_PORT:-80}
SOUND_SUPERVISOR="${SOUND_SUPERVISOR:-$(ip route | awk '/default / { print $3 }'):$SOUND_SUPERVISOR_PORT}"
OUTPUT_MODE=$(curl --silent --max-time 2 "$SOUND_SUPERVISOR/audio/output-mode" 2>/dev/null || echo "MULTIROOM")

NORMAL_LATENCY_MS=${SOUND_INPUT_LATENCY:-200}
NORMAL_LATENCY_MS_OUT=${SOUND_OUTPUT_LATENCY:-200}
INPUT_SINK_NAME=${SOUND_INPUT_SINK:-balena-sound.input}

if [[ "$OUTPUT_MODE" == "LOCAL" ]]; then
  TARGET_STATE="local"
else
  TARGET_STATE="multiroom"
fi

CURRENT_STATE=$(cat /tmp/audio-latency-state 2>/dev/null || echo "none")
[[ "$CURRENT_STATE" == "$TARGET_STATE" ]] && exit 0

INPUT_SINK=$(cat /tmp/balena-sound-input-sink 2>/dev/null)
OUTPUT_SINK=$(cat /tmp/balena-sound-output-sink 2>/dev/null)

# Hardware sink name, written by the audio block on startup.
HW_SINK_FILE=/run/pulse/pulseaudio.sink
if [[ -f "$HW_SINK_FILE" ]]; then
  HW_SINK=$(cat "$HW_SINK_FILE")
fi
HW_SINK="${HW_SINK:-0}"

# Real source streams only: librespot, shairport, Bluetooth and friends all arrive
# over the native protocol, while the internal plumbing is module-loopback. Moving
# a loopback is what previously fed balena-sound.input from its own monitor, which
# is a feedback loop, so those must never be touched here.
#
# Long-form output is parsed rather than `short` because the driver is unambiguous
# there; the column order of `short` is not worth betting the routing on.
source_stream_inputs() {
  pactl list sink-inputs 2>/dev/null | awk '
    /^Sink Input #/  { idx = substr($3, 2); drv = "" }
    /^[[:space:]]*Driver:/ { drv = $2 }
    /^[[:space:]]*Sink:/   { if (idx != "" && drv == "protocol-native.c") print idx }
  '
}

# Silence the hardware while the graph is rebuilt, then let it settle before letting
# audio through again. Rewiring a live sink is what pops the speakers.
mute_hw()   { pactl set-sink-mute "$HW_SINK" 1 2>/dev/null || true; }
unmute_hw() { sleep 0.2; pactl set-sink-mute "$HW_SINK" 0 2>/dev/null || true; }

unload_all_loopbacks() {
  while read -r id _ name rest; do
    [[ "$name" == "module-loopback" ]] && pactl unload-module "$id" 2>/dev/null || true
  done < <(pactl list modules short 2>/dev/null)
}

# Rebuild the full expected set of loopbacks from scratch.
#
# Counting them and topping up if there were "not enough" cannot work: it knows how
# many exist, never which ones, so a missing loopback is invisible while repeated
# runs stack duplicates. Duplicates are not cosmetic, they are audible feedback,
# because a second copy can end up feeding balena-sound.input from a monitor.
#
# Tearing down first also fixes the soundcard input. LOCAL unloads every loopback
# including the capture device's, and only rebuilding two of them left a turntable
# silent until the container happened to restart.
reload_loopbacks() {
  unload_all_loopbacks

  pactl load-module module-loopback latency_msec=$NORMAL_LATENCY_MS source=balena-sound.input.monitor $INPUT_SINK 2>/dev/null || true
  pactl load-module module-loopback latency_msec=$NORMAL_LATENCY_MS_OUT source=balena-sound.output.monitor $OUTPUT_SINK 2>/dev/null || true

  # Same rule start.sh applies at boot: only wire a capture device in if one exists
  # and the user asked for it.
  if [[ -n "$SOUND_ENABLE_SOUNDCARD_INPUT" ]]; then
    local input_device
    input_device=$(arecord -l 2>/dev/null | awk '/card [0-9]:/ { print $3 }' | head -1)
    if [[ -n "$input_device" ]]; then
      pactl load-module module-loopback "source=alsa_input.${input_device}.stereo-fallback" "sink=${INPUT_SINK_NAME}" 2>/dev/null || true
      echo "Restored soundcard input from alsa_input.${input_device}.stereo-fallback"
    fi
  fi

  sleep 0.2
}

if [[ "$TARGET_STATE" == "local" ]]; then
  # --- LOCAL: film mode. Source -> hardware, nothing in between. ---
  mute_hw

  # Unload every loopback; each one costs latency we are trying to remove.
  unload_all_loopbacks

  # New connections (a projector pairing over Bluetooth) should land on hardware.
  pactl set-default-sink "$HW_SINK" 2>/dev/null || true

  for si_id in $(source_stream_inputs); do
    pactl move-sink-input "$si_id" "$HW_SINK" 2>/dev/null || true
  done

  unmute_hw
  echo "$TARGET_STATE" > /tmp/audio-latency-state
  echo "Audio mode LOCAL: sources routed straight to $HW_SINK, loopbacks removed"

else
  # --- MULTIROOM: normal operation. ---

  # On a fresh start there is nothing to restore: balena-sound.pa has already wired
  # the loopbacks and the default sink. Just record the state. Without this the
  # restore below runs on every boot, because the state file lives in /tmp and is
  # therefore always empty at startup, and rewires a correct graph into a broken one.
  if [[ "$CURRENT_STATE" == "none" ]]; then
    echo "$TARGET_STATE" > /tmp/audio-latency-state
    exit 0
  fi

  [[ -z "$INPUT_SINK" || -z "$OUTPUT_SINK" ]] && exit 1

  mute_hw

  reload_loopbacks

  pactl set-default-sink "$INPUT_SINK_NAME" 2>/dev/null || true

  # Send the real sources back to the input sink. The loopbacks just reloaded are
  # skipped by source_stream_inputs, so they stay where they were created.
  for si_id in $(source_stream_inputs); do
    pactl move-sink-input "$si_id" "$INPUT_SINK_NAME" 2>/dev/null || true
  done

  unmute_hw
  echo "$TARGET_STATE" > /tmp/audio-latency-state
  echo "Audio mode MULTIROOM: loopbacks restored (input ${NORMAL_LATENCY_MS}ms, output ${NORMAL_LATENCY_MS_OUT}ms)"
fi
