#!/usr/bin/env bash
# AI detection for prv videos the prod host cannot fetch (yt-dlp: "not available in your country"):
# their info JSON and ru subtitles come from this machine behind a VPN of the platform's country, then
# `ai detect <native_id>` runs on prod for each of them with YTDLP_BIN = the e2e stub serving those files.
# Recipe: docs/reference/ops.md → Geo-blocked videos.
#
#   scripts/geo-subs.sh list   <dir>   VPN off: the videos' ids and the page URL template from prod
#   scripts/geo-subs.sh fetch  <dir>   VPN on: yt-dlp here; resumable, a re-run skips fetched videos
#   scripts/geo-subs.sh run    <dir>   VPN off: upload, start the hand runs on the host in the background
#   scripts/geo-subs.sh status <dir>   the host log's tail
#
# The repo names no host or container: PROD_HOST (user@host) and APP_CONTAINER (<project>-app-1) come
# from the env (list, run, status).
set -euo pipefail

cmd=${1:-}
dir=${2:-}
[ -n "$cmd" ] && [ -n "$dir" ] || { sed -n '7,10p' "$0" >&2; exit 1; }
mkdir -p "$dir"
YTDLP_VERSION=2026.10.21 # the image's (Dockerfile)

need_prod() {
  [ -n "${PROD_HOST:-}" ] && [ -n "${APP_CONTAINER:-}" ] ||
    { echo "PROD_HOST=user@host and APP_CONTAINER=<project>-app-1 are required" >&2; exit 1; }
}

ytdlp() {
  local bin=${YTDLP_BIN:-$(command -v yt-dlp || echo "$HOME/.local/bin/yt-dlp")}
  if [ ! -x "$bin" ]; then
    local f=yt-dlp_macos tmp
    [ "$(uname)" = Darwin ] || f=yt-dlp_linux
    tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/$f" "https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/$f"
    curl -fsSL -o "$tmp/SUMS" "https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/SHA2-256SUMS"
    (cd "$tmp" && grep " $f\$" SUMS | shasum -a 256 -c - >/dev/null)
    mkdir -p "$(dirname "$bin")"
    install -m 0755 "$tmp/$f" "$bin"
    rm -rf "$tmp"
  fi
  echo "$bin"
}

case $cmd in
list)
  need_prod
  # Rows that keep failing on the host's country and have no AI row; highest views first.
  ssh "$PROD_HOST" "sudo -u postgres psql -d \$(docker exec $APP_CONTAINER printenv DB_NAME) -Atc \"
    SELECT a.native_id FROM prv_ai_videos a
    WHERE a.status IN ('failed', 'queued') AND a.last_error LIKE '%not available in your country%'
      AND NOT EXISTS (SELECT 1 FROM prv_ai_video_calculateds c WHERE c.native_id = a.native_id)
    ORDER BY a.views_max DESC NULLS LAST, a.requests DESC\"" > "$dir/ids.txt"
  ssh "$PROD_HOST" "docker exec $APP_CONTAINER printenv PROVIDER_VIDEO_URL" > "$dir/video-url"
  grep -q '{id}' "$dir/video-url" || { echo "no {id} in the URL template" >&2; exit 1; }
  echo "$(grep -c . "$dir/ids.txt") videos in $dir/ids.txt"
  ;;
fetch)
  [ -s "$dir/ids.txt" ] && [ -s "$dir/video-url" ] || { echo "run list first" >&2; exit 1; }
  bin=$(ytdlp)
  tmpl=$(cat "$dir/video-url")
  total=$(grep -c . "$dir/ids.txt")
  n=0 got=0 notrack=0 failed=0
  while read -r id; do
    [ -n "$id" ] || continue
    n=$((n + 1))
    [ -s "$dir/$id.info.json" ] && continue
    url=${tmpl//\{id\}/$id}
    if ! "$bin" -j --skip-download --no-warnings "$url" > "$dir/$id.tmp" 2> "$dir/err.tmp"; then
      printf '%s\t%s\n' "$id" "$(tail -1 "$dir/err.tmp")" >> "$dir/errors.tsv"
      rm -f "$dir/$id.tmp"
      failed=$((failed + 1))
    else
      # The track the product picks (ai/provider PickTrack): uploaded ru subtitles, else auto ones.
      if jq -e '(.subtitles.ru // []) | length > 0' "$dir/$id.tmp" >/dev/null; then flag=--write-subs
      elif jq -e '(.automatic_captions.ru // []) | length > 0' "$dir/$id.tmp" >/dev/null; then flag=--write-auto-subs
      else flag=; fi
      if [ -z "$flag" ]; then
        mv "$dir/$id.tmp" "$dir/$id.info.json" # the hand run records no_track
        notrack=$((notrack + 1))
      elif "$bin" "$flag" --sub-langs ru --sub-format vtt --compat-options allow-unsafe-ext \
          --skip-download --no-warnings -o "$dir/$id.sub" "$url" 2> "$dir/err.tmp" &&
          vtt=$(ls "$dir/$id.sub.ru"* 2>/dev/null | head -1) && [ -n "$vtt" ]; then
        mv "$vtt" "$dir/$id.ru.vtt"
        mv "$dir/$id.tmp" "$dir/$id.info.json"
        got=$((got + 1))
      else
        printf '%s\tsubs: %s\n' "$id" "$(tail -1 "$dir/err.tmp")" >> "$dir/errors.tsv"
        rm -f "$dir/$id.tmp" "$dir/$id.sub."*
        failed=$((failed + 1))
      fi
    fi
    printf '\r%d/%d: %d with subtitles, %d without a ru track, %d failed' "$n" "$total" "$got" "$notrack" "$failed"
    sleep $((1 + RANDOM % 3)) # the platform sees one viewer, not a burst
  done < "$dir/ids.txt"
  rm -f "$dir/err.tmp"
  echo
  echo "$(ls "$dir" | grep -c '\.ru\.vtt$') with subtitles, $(ls "$dir" | grep -c '\.info\.json$') info files in $dir"
  ;;
run)
  need_prod
  remote=geo-subs-$(date +%Y%m%d-%H%M%S)
  # Hand-run order = ids.txt (views first), only the videos fetched here and not sent by an earlier run
  # (a fetch stopped halfway is sent, then the rest after a re-run of fetch).
  touch "$dir/sent.txt"
  while read -r id; do
    if [ -s "$dir/$id.info.json" ] && ! grep -qxF "$id" "$dir/sent.txt"; then echo "$id"; fi
  done < "$dir/ids.txt" > "$dir/order.txt"
  [ -s "$dir/order.txt" ] || { echo "nothing new fetched in $dir" >&2; exit 1; }
  (cd "$dir" && { echo order.txt; sed 's/$/.info.json/' order.txt; sed 's/$/.ru.vtt/' order.txt |
    while read -r f; do if [ -e "$f" ]; then echo "$f"; fi; done; } |
    COPYFILE_DISABLE=1 tar czf - -T -) |
    ssh "$PROD_HOST" "mkdir -p $remote/data && tar xzf - -C $remote/data"
  scp -q "$(dirname "$0")/geo-subs-host.sh" "$PROD_HOST:$remote/"
  ssh "$PROD_HOST" "APP_CONTAINER=$APP_CONTAINER nohup bash $remote/geo-subs-host.sh $remote \
    > $remote/run.log 2>&1 < /dev/null &"
  echo "$remote" > "$dir/remote"
  cat "$dir/order.txt" >> "$dir/sent.txt"
  echo "started $(grep -c . "$dir/order.txt") videos on the host; log: ~/$remote/run.log"
  ;;
status)
  need_prod
  [ -s "$dir/remote" ] || { echo "no run started from $dir" >&2; exit 1; }
  ssh "$PROD_HOST" "tail -n 20 $(cat "$dir/remote")/run.log"
  ;;
*)
  sed -n '7,10p' "$0" >&2
  exit 1
  ;;
esac
