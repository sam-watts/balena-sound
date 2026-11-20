#!/bin/bash
set -e

SOUND_SUPERVISOR_PORT=${SOUND_SUPERVISOR_PORT:-80}
SOUND_SUPERVISOR="${SOUND_SUPERVISOR:-$(ip route | awk '/default / { print $3 }'):$SOUND_SUPERVISOR_PORT}"
while ! curl --silent --output /dev/null "$SOUND_SUPERVISOR/ping"; do sleep 5; echo "Waiting for sound supervisor to start at $SOUND_SUPERVISOR"; done

MODE=$(curl --silent "$SOUND_SUPERVISOR/mode" || true)
if [[ "$MODE" != "MULTI_ROOM" ]]; then
  echo "Multi-room server disabled in mode '$MODE'. Exiting..."
  exit 0
fi

# --- Spotify (librespot), launched and owned by snapserver ---
SOUND_DEVICE_NAME=${SOUND_DEVICE_NAME:-"balenaSound Spotify $(echo "$BALENA_DEVICE_UUID" | cut -c -4)"}
SOUND_SPOTIFY_BITRATE=${SOUND_SPOTIFY_BITRATE:-160}

LIBRESPOT_ARGS="--name \"$SOUND_DEVICE_NAME\" --backend pipe --bitrate $SOUND_SPOTIFY_BITRATE"
LIBRESPOT_ARGS+=" --cache /var/cache/raspotify --volume-ctrl linear --initial-volume 100"
[[ -z ${SOUND_SPOTIFY_ENABLE_CACHE+x} ]] && LIBRESPOT_ARGS+=" --disable-audio-cache"
[[ -z ${SOUND_SPOTIFY_DISABLE_NORMALISATION+x} ]] && LIBRESPOT_ARGS+=" --enable-volume-normalisation"

# The params go in a URI query string, so percent-encode the characters that
# would otherwise end or split it.
urlencode() {
  sed -e 's/%/%25/g' -e 's/ /%20/g' -e 's/"/%22/g' -e 's/&/%26/g' -e 's/=/%3D/g' -e 's/?/%3F/g' -e 's/#/%23/g' <<< "$1"
}

cat > /etc/snapserver.conf <<EOF
[server]
datadir = /var/cache/snapcast/

[http]
enabled = true
bind_to_address = 0.0.0.0
port = 1780

[stream]
# Raw PCM: no FLAC encode on the master or decode on clients.
codec = pcm
sampleformat = 44100:16:2
stream = process:///usr/bin/librespot?name=balenaSound&log_stderr=true&params=$(urlencode "$LIBRESPOT_ARGS")

[logging]
filter = *:notice
EOF

echo "Starting multi-room server (direct mode)..."
echo "- Spotify device name: $SOUND_DEVICE_NAME"
echo "- librespot: $LIBRESPOT_ARGS"
mkdir -p /var/cache/snapcast /var/cache/raspotify
exec /usr/bin/snapserver -c /etc/snapserver.conf
