#!/usr/bin/env bash
# Self-test for classify-doc-changes.sh against real Git output in throwaway repositories.
# Usage: bash scripts/ci/classify-doc-changes.test.sh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
classifier=${CLASSIFIER:-"$here/classify-doc-changes.sh"}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
pass=0
fail=0

g() { git -C "$repo" -c core.hooksPath=/dev/null -c user.name=ci-test -c user.email=ci-test@example.invalid "$@"; }

new_repo() {
  repo="$work/repo$((pass + fail))"
  git init -q -b main "$repo"
  mkdir -p "$repo/docs/设计 目录" "$repo/src" "$repo/server"
  printf 'base\n' >"$repo/README.md"
  printf 'doc\n' >"$repo/docs/guide.md"
  printf 'doc\n' >"$repo/docs/设计 目录/外汇结汇与差异损益.md"
  printf 'export const a = 1;\n' >"$repo/src/app.ts"
  printf 'server notes\n' >"$repo/server/README.md"
  g add -A
  g commit -q -m base
  base=$(g rev-parse HEAD)
}

commit_all() { g add -A; g commit -q --allow-empty -m change; head=$(g rev-parse HEAD); }

# expect <name> <expected: true|false|error> [event]
expect() {
  local name=$1 want=$2 event=${3-pull_request} out status got
  set +e
  out=$(cd "$repo" && GITHUB_OUTPUT="$work/out" bash "$classifier" "$event" "$base" "$head" 2>&1)
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then got=error; else got=$(sed -n 's/^docs_only=//p' <<<"$out" | tail -n 1); fi
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); echo "ok   $name -> $got"
  else
    fail=$((fail + 1)); echo "FAIL $name: want $want, got $got"; sed 's/^/     | /' <<<"$out"
  fi
}

new_repo; printf 'more\n' >>"$repo/docs/guide.md"; commit_all
expect 'ASCII docs file' true

new_repo; printf 'more\n' >>"$repo/docs/设计 目录/外汇结汇与差异损益.md"; mkdir -p "$repo/docs/新增"; printf 'x\n' >"$repo/docs/新增/模块概述.md"; commit_all
expect 'Chinese path with space under docs/' true

new_repo; printf 'x\n' >"$repo/docs/say \"hi\" it's.md"; printf 'x\n' >"$repo/docs/tab	and\\back.md"; commit_all
expect 'quotes, tab and backslash under docs/' true

new_repo; printf 'x\n' >"$repo/docs/line
break.md"; commit_all
expect 'newline inside docs/ path' true

new_repo; mkdir -p "$repo/src/x
docs"; printf 'x\n' >"$repo/src/x
docs/evil.md"; commit_all
expect 'source path whose second line looks like docs/' false

new_repo; printf 'more\n' >>"$repo/README.md"; printf 'x\n' >"$repo/中文 说明.md"; commit_all
expect 'top-level README.md and Chinese top-level md' true

new_repo; g rm -q "docs/guide.md"; commit_all
expect 'docs deletion' true

new_repo; g mv "docs/guide.md" "docs/设计 目录/改名.md"; commit_all
expect 'rename within docs/' true

new_repo; g mv "README.md" "docs/README.md"; commit_all
expect 'top-level md moved into docs/' true

new_repo; printf 'more\n' >>"$repo/docs/guide.md"; printf 'export const b = 2;\n' >>"$repo/src/app.ts"; commit_all
expect 'docs mixed with source change' false

new_repo; g rm -q "src/app.ts"; commit_all
expect 'source deletion' false

new_repo; g mv "src/app.ts" "docs/app.ts"; commit_all
expect 'source renamed into docs/' false

new_repo; g mv "src/app.ts" "docs/设计 目录/迁移.md"; commit_all
expect 'source renamed into Chinese docs/ path' false

new_repo; printf 'more\n' >>"$repo/server/README.md"; commit_all
expect 'nested md outside docs/' false

new_repo; mkdir -p "$repo/docsx"; printf 'x\n' >"$repo/docsx/a.md"; commit_all
expect 'docs-like prefix outside docs/' false

new_repo; printf '{}\n' >"$repo/package.json"; commit_all
expect 'top-level non-md file' false

new_repo; commit_all
expect 'empty diff' false

new_repo; printf 'more\n' >>"$repo/docs/guide.md"; commit_all
expect 'push to main with docs change' false push
expect 'manual run with docs change' false workflow_dispatch

new_repo; printf 'trailing space   \n' >>"$repo/docs/设计 目录/外汇结汇与差异损益.md"; commit_all
expect 'docs-only whitespace error fails' error

new_repo; printf 'more\n' >>"$repo/docs/guide.md"; commit_all; base=0000000000000000000000000000000000000000
expect 'unknown base sha' false

echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
