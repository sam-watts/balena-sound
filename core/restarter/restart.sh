#!/bin/sh
# Restart the app's services once a day.
#
# Three things this has to get right:
#
#  - Never restart our own container. Doing that kills this loop part way through,
#    so whichever services happened to sort after us were silently left running.
#    Which ones those were varied run to run.
#
#  - Never restart the balena supervisor. `docker ps -q` lists every running
#    container on the device, not just this app's.
#
#  - Don't compare against an exact clock string. `sleep 60` drifts, so testing for
#    "= 02:00" skipped the restart entirely on some days. Fire once per day on the
#    first tick inside the target hour instead.

RESTART_HOUR="${RESTART_HOUR:-2}"
LAST_RUN=""

while true; do
  TODAY=$(date +%Y-%m-%d)

  if [ "$(date +%-H)" -eq "$RESTART_HOUR" ] && [ "$TODAY" != "$LAST_RUN" ]; then
    LAST_RUN="$TODAY"
    echo "[restarter] Daily restart executed at $(date '+%Y-%m-%dT%H:%M:%S')"

    for id in $(docker ps -q); do
      service=$(docker inspect -f '{{ index .Config.Labels "io.balena.service-name" }}' "$id" 2>/dev/null)
      case "$service" in
        ''|'<no value>'|restarter|balena_supervisor|resin_supervisor)
          continue
          ;;
      esac
      echo "[restarter] restarting $service"
      docker restart "$id"
    done
  fi

  sleep 60
done
