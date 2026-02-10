#!/bin/bash
# Session start - Load TinyClaw context and SOUL

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

cat << 'EOF'
🤖 TinyClaw Lite Active

Running in persistent mode with:
- Telegram message integration
- Voice message transcription (Whisper)
- Activity logging
- File sending via Telegram

Stay proactive and responsive to messages.
EOF

# Load SOUL.md if it exists
if [ -f "$SCRIPT_DIR/SOUL.md" ]; then
    echo ""
    echo "--- SOUL ---"
    cat "$SCRIPT_DIR/SOUL.md"
    echo "--- END SOUL ---"
fi

exit 0
