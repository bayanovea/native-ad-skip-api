#!/bin/sh
# Stand-in for yt-dlp in e2e (YTDLP_BIN): `-j` prints <native_id>.info.json, a subtitle
# download copies <native_id>.ru.vtt to <-o>.ru.vtt. No info file = yt-dlp failing.
dir=$(dirname "$0")
mode=info
out=
url=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    --write-subs|--write-auto-subs) mode=subs ;;
    https://*) url=$1 ;;
  esac
  shift
done
id=${url#https://example.invalid/video}
if [ ! -f "$dir/$id.info.json" ]; then
  echo "ERROR: [prv] $id: This video is unavailable" >&2
  exit 1
fi
case $mode in
  info) cat "$dir/$id.info.json" ;;
  subs) cp "$dir/$id.ru.vtt" "$out.ru.vtt" ;;
esac
