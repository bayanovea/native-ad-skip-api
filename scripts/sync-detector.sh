#!/usr/bin/env bash
# Copy the detector packages and the prompt from the eval checkout into ai/.
# The eval repo is where the detector and its prompts change; this repo takes a copy
# (eval first, then sync). Run: scripts/sync-detector.sh ~/Web/native-ad-skip-eval
set -euo pipefail

EVAL="${1:?usage: scripts/sync-detector.sh <eval checkout>}"
PROMPT="${PROMPT:-v2.2}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGES="detector transcript vtt provider ytdlp"
# Written in this repo, kept across syncs.
PRODUCT_FILES="detector/fixture.go detector/fixture_test.go detector/apikey_test.go"
EVAL_MODULE="github.com/bayanovea/native-ad-skip-eval/internal/"
MODULE="odedohbest/video-calculate/ai/"

[ -z "$(git -C "$EVAL" status --porcelain)" ] || { echo "eval checkout $EVAL has uncommitted changes, commit them first" >&2; exit 1; }
SHA="$(git -C "$EVAL" rev-parse HEAD)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

for pkg in $PACKAGES; do
  mkdir "$STAGE/$pkg"
  for f in "$EVAL/internal/$pkg"/*.go; do
    # claudecli.go drives `claude -p` on a subscription: an eval tool, not for the product.
    # anthropic_test.go tests the key-file lookup dropped below; apikey_test.go replaces it.
    case "$pkg/$(basename "$f")" in detector/claudecli.go|detector/anthropic_test.go) continue ;; esac
    sed "s#$EVAL_MODULE#$MODULE#g" "$f" > "$STAGE/$pkg/$(basename "$f")"
  done
done

# The key comes from ANTHROPIC_API_KEY only; the eval's key-file lookup (apiKeyPath) is dropped.
ANTHROPIC="$STAGE/detector/anthropic.go"
awk '
  /^\/\/ apiKeyPath is where/ { skip = 1 }
  skip && /^func newAPIClient\(/ { in_client = 1 }
  skip && in_client && /^}/ {
    print "// newAPIClient reads the key from ANTHROPIC_API_KEY only (the deploy env)."
    print "func newAPIClient() (anthropic.Client, error) {"
    print "\tkey := strings.TrimSpace(os.Getenv(\"ANTHROPIC_API_KEY\"))"
    print "\tif key == \"\" {"
    print "\t\treturn anthropic.Client{}, errors.New(\"ANTHROPIC_API_KEY is not set\")"
    print "\t}"
    print "\treturn anthropic.NewClient(option.WithAPIKey(key)), nil"
    print "}"
    skip = 0; in_client = 0; next
  }
  !skip
' "$ANTHROPIC" > "$ANTHROPIC.new"
mv "$ANTHROPIC.new" "$ANTHROPIC"
sed -i.bak 's#^// from apiKeyPath\.$#// from ANTHROPIC_API_KEY.#' "$ANTHROPIC"
grep -q 'filepath\.' "$ANTHROPIC" || sed -i.bak '/^	"path\/filepath"$/d' "$ANTHROPIC"
rm -f "$ANTHROPIC.bak"
if grep -q 'apiKeyPath' "$ANTHROPIC"; then
  echo "anthropic.go changed shape in the eval, apiKeyPath not removed: update this script" >&2
  exit 1
fi

for f in $PRODUCT_FILES; do
  [ -f "$ROOT/ai/$f" ] && cp "$ROOT/ai/$f" "$STAGE/$f"
done
mkdir -p "$ROOT/ai/prompts"
for pkg in $PACKAGES; do
  rm -rf "${ROOT:?}/ai/$pkg"
  cp -R "$STAGE/$pkg" "$ROOT/ai/$pkg"
done
cp "$EVAL/prompts/$PROMPT.md" "$ROOT/ai/prompts/$PROMPT.md"
echo "$SHA" > "$ROOT/ai/SOURCE"

sdk() { grep -oE "$2 v[^ ]+" "$1" | cut -d' ' -f2 || true; }
for mod in github.com/anthropics/anthropic-sdk-go github.com/openai/openai-go/v3; do
  want="$(sdk "$EVAL/go.mod" "$mod")"
  have="$(sdk "$ROOT/go.mod" "$mod")"
  if [ "$want" != "$have" ]; then
    echo "$mod: eval $want, here ${have:-none}: go get $mod@$want && go mod tidy && go mod vendor" >&2
  fi
done

cd "$ROOT"
go build -mod=vendor ./ai/...
echo "ok ai/ from eval ${SHA:0:7}, prompt $PROMPT"
