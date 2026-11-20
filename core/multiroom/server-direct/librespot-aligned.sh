#!/bin/bash
# Run librespot for snapserver's process:// source with frame-aligned output.
#
# snapserver 0.26 (PosixStream::do_read) reads a 20 ms chunk at a time. If a read
# returns part of a chunk and the next one finds the pipe empty, it pads the rest of
# the chunk with zeros and moves on. When that partial read ended mid-frame, every
# later sample is read at the wrong byte offset: loud noise, typically right after a
# skip, when librespot's output pauses while the next track loads. librespot's writes
# are not frame aligned (Rust's stdout is line buffered, so it splits binary PCM at
# arbitrary 0x0A bytes).
#
# dd with iflag=fullblock only ever writes whole 3528-byte blocks: one 20 ms chunk at
# 44100:16:2, a multiple of the 4-byte frame, and under PIPE_BUF so each write is
# atomic. snapserver then reads a whole aligned chunk or nothing.
set -o pipefail

# snapserver kills only this script's PID when it restarts the source, which would
# leave the previous librespot running and advertising a second Spotify device.
pkill -x librespot 2>/dev/null || true

/usr/bin/librespot "$@" | dd bs=3528 iflag=fullblock status=none
