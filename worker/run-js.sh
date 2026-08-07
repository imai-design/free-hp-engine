#!/bin/bash
# 使い方: ./run-js.sh script.js [timeout秒]  — nodeを背景実行し、時間で必ず殺し、出力を表示する
S="$1"; T="${2:-60}"
node "$S" > "/tmp/runjs.out" 2>&1 &
P=$!
( sleep "$T"; kill "$P" 2>/dev/null ) &
G=$!
wait "$P" 2>/dev/null
kill "$G" 2>/dev/null
cat /tmp/runjs.out
