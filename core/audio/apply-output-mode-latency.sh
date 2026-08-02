#!/bin/bash
# Apply audio routing based on supervisor audio output mode.
# LOCAL  = bypass loopbacks entirely, route sink inputs directly to hardware (lowest latency for films).
# MULTIROOM = restore loopback modules with normal latency for snapcast distribution.
# Called periodically by start.sh.

SOUND_SUPERVISOR_PORT=${SOUND_SUPERVISOR_PORT:-80}
SOUND_SUPERVISOR="${SOUND_SUPERVISOR:-$(ip route | awk '/default / { print $3 }'):$SOUND_SUPERVISOR_PORT}"
OUTPUT_MODE=$(curl --silent --max-time 2 "$SOUND_SUPERVISOR/audio/output-mode" 2>/dev/null || echo "MULTIROOM")

NORMAL_LATENCY_MS=${SOUND_INPUT_LATENCY:-200}
NORMAL_LATENCY_MS_OUT=${SOUND_OUTPUT_LATENCY:-200}

if [[ "$OUTPUT_MODE" == "LOCAL" ]]; then
  TARGET_STATE="local"
else
  TARGET_STATE="multiroom"
fi

CURRENT_STATE=$(cat /tmp/audio-latency-state 2>/dev/null || echo "none")
[[ "$CURRENT_STATE" == "$TARGET_STATE" ]] && exit 0

INPUT_SINK=$(cat /tmp/balena-sound-input-sink 2>/dev/null)
OUTPUT_SINK=$(cat /tmp/balena-sound-output-sink 2>/dev/null)

# Read hardware sink name from the audio block
HW_SINK_FILE=/run/pulse/pulseaudio.sink
if [[ -f "$HW_SINK_FILE" ]]; then
  HW_SINK=$(cat "$HW_SINK_FILE")
fi
HW_SINK="${HW_SINK:-0}"

if [[ "$TARGET_STATE" == "local" ]]; then
  # --- LOCAL mode: bypass loopbacks, route directly to hardware ---

  # Unload all loopback modules (they add ~68-136ms latency)
  while read -r id _ name rest; do
    [[ "$name" == "module-loopback" ]] && pactl unload-module "$id" 2>/dev/null || true
  done < <(pactl list modules short 2>/dev/null)

  # Set hardware as default sink so new BT connections go directly there
  pactl set-default-sink "$HW_SINK" 2>/dev/null || true

  # Move ALL existing sink inputs to hardware
  while read -r si_id _ sink_name _rest; do
    pactl move-sink-input "$si_id" "$HW_SINK" 2>/dev/null || true
  done < <(pactl list sink-inputs short 2>/dev/null)

  echo "$TARGET_STATE" > /tmp/audio-latency-state
  echo "Audio latency set to local (loopbacks bypassed, default sink: $HW_SINK)"

else
  # --- MULTIROOM mode: restore loopback modules with normal latency ---

  # Only reload if input/output sink config is available
  [[ -z "$INPUT_SINK" || -z "$OUTPUT_SINK" ]] && exit 1

  # Check if loopbacks are already loaded
  LOOPBACKS_LOADED=0
  while read -r id _ name rest; do
    [[ "$name" == "module-loopback" ]] && LOOPBACKS_LOADED=$((LOOPBACKS_LOADED + 1))
  done < <(pactl list modules short 2>/dev/null)

  if [[ "$LOOPBACKS_LOADED" -lt 2 ]]; then
    # Reload loopback modules with normal latency
    pactl load-module module-loopback latency_msec=$NORMAL_LATENCY_MS source=balena-sound.input.monitor $INPUT_SINK 2>/dev/null || true
    pactl load-module module-loopback latency_msec=$NORMAL_LATENCY_MS_OUT source=balena-sound.output.monitor $OUTPUT_SINK 2>/dev/null || true
    sleep 0.2
  fi

  # Restore default sink to balena-sound.input for normal routing
  pactl set-default-sink "balena-sound.input" 2>/dev/null || true

  # Move all sink inputs back to balena-sound.input
  while read -r si_id _ sink_name _rest; do
    pactl move-sink-input "$si_id" "balena-sound.input" 2>/dev/null || true
  done < <(pactl list sink-inputs short 2>/dev/null)

  echo "$TARGET_STATE" > /tmp/audio-latency-state
  echo "Audio latency set to multiroom (loopbacks restored, input ${NORMAL_LATENCY_MS}ms, output ${NORMAL_LATENCY_MS_OUT}ms)"
fi
