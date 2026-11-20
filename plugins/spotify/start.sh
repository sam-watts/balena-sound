#!/usr/bin/env bash

if [[ -n "$SOUND_DISABLE_SPOTIFY" ]]; then
  echo "Spotify is disabled, exiting..."
  exit 0
fi

# --- ENV VARS ---
# SOUND_DEVICE_NAME: Set the device broadcast name for Spotify
# SOUND_SPOTIFY_BITRATE: Set the playback bitrate
SOUND_DEVICE_NAME=${SOUND_DEVICE_NAME:-"balenaSound Spotify $(echo "$BALENA_DEVICE_UUID" | cut -c -4)"}
SOUND_SPOTIFY_BITRATE=${SOUND_SPOTIFY_BITRATE:-160}

# SOUND_SPOTIFY_DISABLE_NORMALISATION: Disable volume normalization
if [[ -z ${SOUND_SPOTIFY_DISABLE_NORMALISATION+x} ]]; then
  set -- "$@" \
    --enable-volume-normalisation
fi

# SOUND_SPOTIFY_USERNAME: Login username for Spotify
# SOUND_SPOTIFY_PASSWORD: Login password for Spotify
if [[ -n "$SOUND_SPOTIFY_USERNAME" ]] && [[ -n "$SOUND_SPOTIFY_PASSWORD" ]]; then
  set -- "$@" \
    --username "$SOUND_SPOTIFY_USERNAME" \
    --password "$SOUND_SPOTIFY_PASSWORD"
fi

# SOUND_SPOTIFY_ENABLE_CACHE: Enable Spotify audio cache
if [[ -z ${SOUND_SPOTIFY_ENABLE_CACHE+x} ]]; then
  set -- "$@" \
    --disable-audio-cache
fi

# Start librespot
# We use set/$@ because librespot for some reason does not like env vars and quote escapes
echo "Starting Spotify plugin..."
echo "Device name: $SOUND_DEVICE_NAME"
[[ -n "$SOUND_SPOTIFY_USERNAME" ]] && [[ -n "$SOUND_SPOTIFY_PASSWORD" ]] && echo "Using provided credentials for Spotify login."
[[ -n ${SOUND_SPOTIFY_DISABLE_NORMALISATION+x} ]] && echo "Volume normalization disabled."
[[ -n ${SOUND_SPOTIFY_ENABLE_CACHE+x} ]] && echo "Spotify audio cache enabled."

# SOUND_SPOTIFY_PIPE: write raw PCM into this FIFO (read by snapserver) instead of
# PulseAudio. Used in direct mode to keep PulseAudio out of the multiroom path.
# snapserver creates the FIFO; wait for it rather than letting librespot create a
# regular file of the same name that snapserver would then never read.
if [[ -n "$SOUND_SPOTIFY_PIPE" ]]; then
  until [[ -p "$SOUND_SPOTIFY_PIPE" ]]; do
    echo "Waiting for snapserver to create $SOUND_SPOTIFY_PIPE..."
    sleep 5
  done
  echo "Output: pipe $SOUND_SPOTIFY_PIPE (direct to snapserver)"
  # Write to stdout and let the shell hold the FIFO open for librespot's whole life.
  # With --device, librespot opens the path when its sink starts and closes it when
  # it stops, which it did every few seconds during playback: snapserver saw EOF,
  # reopened, and every client got a gap and an XRUN. librespot logs to stderr, so
  # stdout carries only PCM.
  BACKEND=(--backend pipe)
  exec > "$SOUND_SPOTIFY_PIPE"
else
  BACKEND=(--backend pulseaudio)
fi

set -- /usr/bin/librespot \
  "${BACKEND[@]}" \
  --name "$SOUND_DEVICE_NAME" \
  --bitrate "$SOUND_SPOTIFY_BITRATE" \
  --cache /var/cache/raspotify \
  --volume-ctrl linear \
  "$@"

exec "$@"
