#!/bin/bash
# CodeArena Quick Update Script
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "📥 Pulling latest updates from GitHub..."
git pull

echo "🔄 Reloading CodeArena..."
if systemctl is-active --quiet codearena 2>/dev/null; then
    sudo systemctl restart codearena
    echo "✅ CodeArena systemd service restarted!"
else
    pkill -f serve.py || true
    sleep 1
    export JAVA_JUDGE_URL="${JAVA_JUDGE_URL:-https://codearena-java-judge-240990391896.us-central1.run.app}"
    nohup python3 serve.py > arena.log 2>&1 &
    echo "✅ CodeArena restarted in background!"
fi

echo "🚀 Live and ready at your domain!"
