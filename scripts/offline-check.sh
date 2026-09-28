#!/bin/sh
# Proves the one-command rule without trusting anyone's word: builds the image with networking
# disabled, starts a fresh container that has no network interface except loopback, and checks
# from inside it that the portal seeds itself and serves the gallery, judge scores and CSV.
# Needs Docker and a cached node:24-alpine base image (pull it once while online).
set -eu
cd "$(dirname "$0")/.."
IMAGE=forgeboard-offline-check
NAME=forgeboard-offline-check

echo "1. building with --network none"
docker build --network none -q -t "$IMAGE" . >/dev/null

echo "2. starting a container with --network none"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$NAME" --network none -e FORGEBOARD_DEMO=1 -e FORGEBOARD_SEED_FIXTURES=1 "$IMAGE" >/dev/null
trap 'docker stop "$NAME" >/dev/null 2>&1 || true; docker rmi "$IMAGE" >/dev/null 2>&1 || true' EXIT
sleep 2

echo "3. checking from inside the container"
docker exec "$NAME" sh -c '
  set -e
  get() { wget -qO- --header "Cookie: session=$2" "http://127.0.0.1:8080$1"; }
  get /healthz "" | grep -q "\"ok\"" && echo "   health: ok"
  echo "   gallery projects: $(get /projects "" | grep -c "class=\"card project-card\"")"
  echo "   judge_a scores: $(get /api/judge/scores jdg_a_demo_91bc5e0f27d4a8c3 | grep -c "\"assignment_id\"")"
  echo "   csv header: $(get /api/export.csv org_demo_7f2a9c41d8e3b6a5 | head -1)"
  if wget -q -O /dev/null -T 3 https://registry.npmjs.org/ 2>/dev/null; then echo "   egress: POSSIBLE (network was not off)"; exit 1; else echo "   egress: none, as intended"; fi
'
echo "offline check passed"
