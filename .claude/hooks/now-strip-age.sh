#!/usr/bin/env bash
# Reminds the session when the NOW strip has gone stale.
#
# src/content/now/now.yaml says of itself that it "goes stale by design" and is
# "meant to be edited often". That is a design with no feedback loop: nothing
# makes the decay visible, so the strip goes on claiming a present tense it no
# longer has. This is the loop, and it is the whole of it.
#
# THE AGE COMES FROM GIT RATHER THAN FROM THE FILE'S MTIME. A clone or a branch
# checkout rewrites mtime to the moment it ran, which would report every strip as
# brand new on a machine that has never edited one.
#
# SILENT WHILE THE FILE IS ALREADY MODIFIED, staged or unstaged. A reminder that
# fires in the session where the thing is being fixed is noise, and noise is what
# gets a reminder turned off. Silent too outside a git work tree, and silent when
# the file has no commits at all.
#
# Output is one JSON object on stdout, or nothing. `systemMessage` shows the line
# to the reader without spending the model's context on it.

set -u

THRESHOLD_DAYS="${NOW_STRIP_MAX_AGE_DAYS:-21}"
FILE="src/content/now/now.yaml"

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
[ -f "$FILE" ] || exit 0

git diff --quiet -- "$FILE" 2>/dev/null || exit 0
git diff --quiet --cached -- "$FILE" 2>/dev/null || exit 0

last="$(git log -1 --format=%ct -- "$FILE" 2>/dev/null)"
[ -n "$last" ] || exit 0

age=$(( ( $(date +%s) - last ) / 86400 ))
[ "$age" -ge "$THRESHOLD_DAYS" ] || exit 0

printf '{"systemMessage":"The NOW strip has not changed in %s days. Edit %s to refresh it."}\n' \
  "$age" "$FILE"
