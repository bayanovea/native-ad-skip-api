#!/usr/bin/env bash
# Host side of scripts/geo-subs.sh run: `ai detect <native_id>` inside the app container for each video
# of <dir>/data/order.txt, with YTDLP_BIN = the e2e stub, which serves <id>.info.json and <id>.ru.vtt
# from its own directory. A manual run is synchronous and full price, publishes like a tick and writes
# no heartbeat (docs/reference/ops.md). Usage: APP_CONTAINER=<project>-app-1 geo-subs-host.sh <dir>
set -uo pipefail

dir=$1
c=${APP_CONTAINER:?}
d=/tmp/geo-subs

# A recreated container (a deploy) loses /tmp: copy the files in again before each video.
ensure() {
  docker exec "$c" test -x "$d/yt-dlp-stub.sh" 2>/dev/null && return
  docker exec "$c" mkdir -p "$d" &&
    docker cp "$dir/data/." "$c:$d/" >/dev/null &&
    docker exec "$c" cp /app/test/fixtures/ai/yt-dlp-stub.sh "$d/"
}

# A tick holds the detect lock for most of its 5 minutes, so the hand runs take the second half of each
# 10 minutes: waiting on the lock from :x4:30, they skip the :x5 tick (flock -n) and start no video after
# :x8, leaving the :x0 tick to the cron.
wait_slot() {
  while :; do
    s=$(($(date +%s) % 600))
    [ "$s" -ge 270 ] && [ "$s" -lt 480 ] && return
    sleep 10
  done
}

n=0 published=0
total=$(grep -c . "$dir/data/order.txt")
while read -r id; do
  [ -n "$id" ] || continue
  n=$((n + 1))
  wait_slot
  ensure || { echo "$(date -u +%T) cannot copy the files into $c, stopping"; exit 1; }
  if out=$(docker exec "$c" flock /tmp/ai-detect.lock \
      env YTDLP_BIN="$d/yt-dlp-stub.sh" /app/prv/commands/ai/ai detect "$id" 2>&1); then
    published=$((published + 1))
    st=published
  else
    st=not-published
  fi
  echo "$(date -u +%T) $n/$total $id $st"
  echo "$out" | grep -v '^$' | tail -n 3 | sed 's/^/  /'
done < "$dir/data/order.txt"

docker exec "$c" rm -rf "$d"
rm -rf "$dir/data"
echo "$(date -u +%T) done: $published of $total published"
