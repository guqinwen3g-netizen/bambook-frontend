#!/usr/bin/env bash
# Classify a CI run as documentation-only (lightweight whitespace check) or full verification.
#
# Usage: classify-doc-changes.sh <event> <base-sha> <head-sha>
# Prints "docs_only=true|false" and appends it to $GITHUB_OUTPUT when set.
#
# Rules (fail closed: anything uncertain means full verification):
# - Only pull_request events can be docs-only; push / workflow_dispatch / others are always full.
# - Paths are read NUL-separated (git diff -z), so Chinese, spaces, quotes and other legal characters
#   are compared verbatim instead of Git's quoted/escaped display form (core.quotePath).
# - --no-renames lists a rename as deletion of the old path plus addition of the new path, so moving
#   source into docs/ still counts the removed source path.
# - Docs-only requires a non-empty diff in which every path is under docs/ or is a top-level *.md.
#   Nested *.md outside docs/ (e.g. server/README.md) is not documentation for this purpose.
# - If the diff cannot be computed (unknown base/head), fall back to full verification.
# - A docs-only diff must pass `git diff --check`; whitespace errors exit non-zero.
set -euo pipefail

event=${1-}
base=${2-}
head=${3-}
docs_only=false

is_doc_path() {
  local path=$1
  [[ $path == docs/?* ]] && return 0
  [[ $path != */* && $path == ?*.md ]] && return 0
  return 1
}

emit() {
  echo "docs_only=$docs_only"
  if [ -n "${GITHUB_OUTPUT-}" ]; then echo "docs_only=$docs_only" >>"$GITHUB_OUTPUT"; fi
}

if [ "$event" != pull_request ]; then
  echo "event '$event' always runs full verification"
  emit
  exit 0
fi

if [ -z "$base" ] || [ -z "$head" ]; then
  echo "missing base/head sha; running full verification"
  emit
  exit 0
fi

list=$(mktemp)
trap 'rm -f "$list"' EXIT
if ! git -c core.quotePath=false diff -z --no-renames --no-ext-diff --name-only "$base...$head" -- >"$list"; then
  echo "could not compute diff for $base...$head; running full verification"
  emit
  exit 0
fi

files=()
mapfile -d '' -t files <"$list"

echo "changed files (${#files[@]}):"
non_doc=0
for path in "${files[@]}"; do
  if is_doc_path "$path"; then
    printf '  doc   %s\n' "$path"
  else
    printf '  other %s\n' "$path"
    non_doc=$((non_doc + 1))
  fi
done

if [ "${#files[@]}" -gt 0 ] && [ "$non_doc" -eq 0 ]; then
  docs_only=true
  git diff --check "$base...$head"
fi
emit
