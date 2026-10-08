#!/bin/bash
# CodeArena Quick Update Script
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Questions edited from the admin panel live in tracked files. Keep the server's
# copies so `git pull` neither aborts on local changes nor wipes the edits.
QDATA="public/data/problems.json public/data/tests public/js/problems.js"
BACKUP="$(mktemp -d)"
tar -cf "$BACKUP/questions.tar" $QDATA 2>/dev/null || true
git checkout -- $QDATA 2>/dev/null || true

echo "📥 Pulling latest updates from GitHub..."
if ! git pull; then
    tar -xf "$BACKUP/questions.tar"
    echo "❌ git pull failed — question data restored, server not restarted."
    exit 1
fi
tar -xf "$BACKUP/questions.tar"
rm -rf "$BACKUP"
echo "📝 Admin-edited questions preserved."

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
