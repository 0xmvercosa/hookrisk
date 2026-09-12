#!/usr/bin/env bash
# Rescan the 14 hook clones with a given hookrisk checkout and collect evidence.
# usage: rescan.sh <hookrisk-repo-root> <evidence-out-dir>
set -uo pipefail
ROOT="$1"; OUT="$2"; SC="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
jq -r '.results[] | "\(.slug)\t\(.target)"' "$SC/scan-results.json" | while IFS=$'\t' read -r slug target; do
  proj=$(dirname "$(find "$SC/hooks/$slug/repo" -maxdepth 2 -name hookrisk.toml | head -1)")
  [ -z "$proj" ] && { echo "$slug: no hookrisk.toml"; continue; }
  d="$OUT/$slug"; mkdir -p "$d"
  ( cd "$proj" && HOOKRISK_SLITHER_BIN="$ROOT/.venv/bin/slither" node "$ROOT/cli/dist/cli.js" scan "$target" --verbose --timeout 900 --out "$d" >"$d/scan.stdout" 2>"$d/scan.stderr"; echo $? >"$d/exit_code" )
  ec=$(cat "$d/exit_code")
  if [ -f "$d/hook-risk.json" ]; then
    jq -c --arg slug "$slug" --arg ec "$ec" '{slug:$slug, exit:$ec, tier:.score.tier, total:.score.total, upper:.score.totalUpperBound, findings:[.findings[]|"\(.ruleClass)/\(.severity)"], engines:[.engines[]|"\(.engine):\(.status)"], invariants:[(.invariants//[])[]|"\(.id):\(.status)"], gate:(.gate.passed), harness:(.coverage.harnessStatus // "n/a")}' "$d/hook-risk.json"
  else
    echo "{\"slug\":\"$slug\",\"exit\":\"$ec\",\"error\":\"no manifest\",\"stderr\":\"$(tail -3 "$d/scan.stderr" | tr '\n' ' ' | cut -c1-200)\"}"
  fi
done | tee "$OUT/summary.jsonl"
