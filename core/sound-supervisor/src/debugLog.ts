/**
 * File-based debug logging for instrumentation (e.g. on device where HTTP ingest is unreachable).
 * Writes NDJSON to /tmp/balena-sound-debug.log. Retrieve with: docker exec <container> cat /tmp/balena-sound-debug.log
 */
import * as fs from 'fs'

const DEBUG_LOG_PATH = '/tmp/balena-sound-debug.log'

export function debugLog(payload: {
  sessionId?: string
  runId?: string
  hypothesisId?: string
  location: string
  message: string
  data?: Record<string, unknown>
  timestamp?: number
}): void {
  try {
    const line = JSON.stringify({ ...payload, timestamp: payload.timestamp ?? Date.now() }) + '\n'
    fs.appendFileSync(DEBUG_LOG_PATH, line)
  } catch {
    // ignore
  }
}
