#!/usr/bin/env bash
# Sync the StoryTellAR authoring skills from peeppop-server into the
# storytellar-author Hermes profile's skills/ directory.
#
# The skills live ONLY in joyaether/peeppop-server (.agents/skills/) — this
# script fetches a branch snapshot and drops each skill into the profile.
# Run on the Aquarium box as root (files end up owned by hermes).
#
#   ./sync_storytellar_skills.sh [branch] [profile_dir]
#
# Defaults: branch=storytellar-prod
#           profile_dir=$HERMES_HOME/profiles/storytellar-author
set -euo pipefail

BRANCH="${1:-storytellar-prod}"
HERMES_HOME="${HERMES_HOME:-/opt/data/hermes-home-staging}"
PROFILE_DIR="${2:-$HERMES_HOME/profiles/storytellar-author}"
SKILLS=(go-tour-authoring ar-story-authoring story-modify)
REPO="https://github.com/joyaether/peeppop-server"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "Fetching joyaether/peeppop-server@$BRANCH ..."
git clone --quiet --depth 1 --branch "$BRANCH" --filter=blob:none \
  --sparse "$REPO" "$TMP/repo"
git -C "$TMP/repo" sparse-checkout set .agents/skills

for s in "${SKILLS[@]}"; do
  src="$TMP/repo/.agents/skills/$s"
  [ -d "$src" ] || { echo "MISSING .agents/skills/$s on $BRANCH" >&2; exit 1; }
  rm -rf "$PROFILE_DIR/skills/$s"
  cp -R "$src" "$PROFILE_DIR/skills/$s"
  echo "synced $s"
done
find "$PROFILE_DIR/skills" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
chown -R hermes:hermes "$PROFILE_DIR/skills"
echo "Done -> $PROFILE_DIR/skills"
