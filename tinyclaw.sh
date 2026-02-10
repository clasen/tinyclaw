#!/bin/bash
# TinyClaw Simple - Main daemon using tmux + claude -c -p + Telegram

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMUX_SESSION="tinyclaw"
LOG_DIR="$SCRIPT_DIR/.tinyclaw/logs"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

mkdir -p "$LOG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_DIR/daemon.log"
}

# Check if session exists
session_exists() {
    tmux has-session -t "$TMUX_SESSION" 2>/dev/null
}

# Start daemon
start_daemon() {
    if session_exists; then
        echo -e "${YELLOW}Session already running${NC}"
        return 1
    fi

    log "Starting TinyClaw daemon..."

    # Check if Node.js dependencies are installed
    if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
        echo -e "${YELLOW}Installing Node.js dependencies...${NC}"
        cd "$SCRIPT_DIR"
        npm install
    fi

    # WhatsApp disabled - uncomment to re-enable
    # SESSION_EXISTS=false
    # if [ -d "$SCRIPT_DIR/.tinyclaw/whatsapp-session" ] && [ "$(ls -A $SCRIPT_DIR/.tinyclaw/whatsapp-session 2>/dev/null)" ]; then
    #     SESSION_EXISTS=true
    #     echo -e "${GREEN}✓ WhatsApp session found, skipping QR code${NC}"
    # fi

    # Create detached tmux session with 3 panes
    tmux new-session -d -s "$TMUX_SESSION" -n "tinyclaw" -c "$SCRIPT_DIR"

    # Split into 3 panes
    tmux split-window -v -t "$TMUX_SESSION" -c "$SCRIPT_DIR"
    tmux split-window -h -t "$TMUX_SESSION:0.0" -c "$SCRIPT_DIR"

    # Pane 0 (top-left): Telegram client
    tmux send-keys -t "$TMUX_SESSION:0.0" "cd '$SCRIPT_DIR' && bun telegram-client.js" C-m

    # Pane 1 (top-right): Queue processor
    tmux send-keys -t "$TMUX_SESSION:0.1" "cd '$SCRIPT_DIR' && bun queue-processor.js" C-m

    # Pane 2 (bottom): Logs
    tmux send-keys -t "$TMUX_SESSION:0.2" "cd '$SCRIPT_DIR' && tail -f .tinyclaw/logs/queue.log .tinyclaw/logs/telegram.log" C-m

    # Set pane titles
    tmux select-pane -t "$TMUX_SESSION:0.0" -T "Telegram"
    tmux select-pane -t "$TMUX_SESSION:0.1" -T "Queue"
    tmux select-pane -t "$TMUX_SESSION:0.2" -T "Logs"

    echo ""
    echo -e "${GREEN}✓ TinyClaw started${NC}"
    echo ""

    echo ""
    echo -e "${BLUE}Tmux Session Layout:${NC}"
    echo "  ┌──────────┬──────────┐"
    echo "  │ Telegram │  Queue   │"
    echo "  ├──────────┴──────────┤"
    echo "  │       Logs          │"
    echo "  └─────────────────────┘"
    echo ""
    echo -e "${GREEN}Commands:${NC}"
    echo "  Status:  ./tinyclaw.sh status"
    echo "  Logs:    ./tinyclaw.sh logs telegram"
    echo "  Attach:  tmux attach -t $TMUX_SESSION"
    echo "  Stop:    ./tinyclaw.sh stop"
    echo ""
    echo -e "${YELLOW}Send a Telegram message to test!${NC}"
    echo ""

    log "Daemon started with 3 panes"
}

# Stop daemon
stop_daemon() {
    log "Stopping TinyClaw..."

    if session_exists; then
        tmux kill-session -t "$TMUX_SESSION"
    fi

    # Kill any remaining processes
    # pkill -f "whatsapp-client.js" || true  # WhatsApp disabled
    pkill -f "telegram-client.js" || true
    pkill -f "queue-processor.js" || true

    echo -e "${GREEN}✓ TinyClaw stopped${NC}"
    log "Daemon stopped"
}

# Send message to Claude and get response
send_message() {
    local message="$1"
    local source="${2:-manual}"

    log "[$source] Sending: ${message:0:50}..."

    # Use claude -c -p to continue and get final response
    cd "$SCRIPT_DIR"
    RESPONSE=$(claude --dangerously-skip-permissions -c -p "$message" 2>&1)
    CLAUDE_STATUS=$?

    if [ $CLAUDE_STATUS -ne 0 ] || echo "$RESPONSE" | grep -qi "hit your limit\|rate limit\|quota\|credits"; then
        log "Claude failed or hit limits. Falling back to Codex."
        CODEX_BIN="${CODEX_BIN:-codex}"
        CODEX_BYPASS="${CODEX_BYPASS:-1}"
        CODEX_MODEL_FLAG=""
        if [ -n "${CODEX_MODEL:-}" ]; then
            CODEX_MODEL_FLAG="-m $CODEX_MODEL"
        fi
        CODEX_OUT="$SCRIPT_DIR/.tinyclaw/codex/last_$$.txt"
        mkdir -p "$SCRIPT_DIR/.tinyclaw/codex"
        if [ "$CODEX_BYPASS" = "1" ]; then
            $CODEX_BIN exec --dangerously-bypass-approvals-and-sandbox -C "$SCRIPT_DIR" -o "$CODEX_OUT" $CODEX_MODEL_FLAG "$message" >/dev/null 2>&1
        else
            $CODEX_BIN exec -C "$SCRIPT_DIR" -o "$CODEX_OUT" $CODEX_MODEL_FLAG "$message" >/dev/null 2>&1
        fi
        if [ -f "$CODEX_OUT" ]; then
            RESPONSE=$(cat "$CODEX_OUT")
        else
            RESPONSE="Sorry, I encountered an error processing your request."
        fi
    fi

    echo "$RESPONSE"

    log "[$source] Response length: ${#RESPONSE} chars"
}

# Status
status_daemon() {
    echo -e "${BLUE}TinyClaw Status${NC}"
    echo "==============="
    echo ""

    if session_exists; then
        echo -e "Tmux Session: ${GREEN}Running${NC}"
        echo "  Attach: tmux attach -t $TMUX_SESSION"
    else
        echo -e "Tmux Session: ${RED}Not Running${NC}"
        echo "  Start: ./tinyclaw.sh start"
    fi

    echo ""

    # WhatsApp disabled
    # if pgrep -f "whatsapp-client.js" > /dev/null; then
    #     echo -e "WhatsApp Client: ${GREEN}Running${NC}"
    # else
    #     echo -e "WhatsApp Client: ${RED}Not Running${NC}"
    # fi

    if pgrep -f "telegram-client.js" > /dev/null; then
        echo -e "Telegram Client: ${GREEN}Running${NC}"
    else
        echo -e "Telegram Client: ${RED}Not Running${NC}"
    fi

    if pgrep -f "queue-processor.js" > /dev/null; then
        echo -e "Queue Processor: ${GREEN}Running${NC}"
    else
        echo -e "Queue Processor: ${RED}Not Running${NC}"
    fi

    # WhatsApp disabled
    # echo ""
    # echo "Recent WhatsApp Activity:"
    # echo "─────────────────────────"
    # tail -n 5 "$LOG_DIR/whatsapp.log" 2>/dev/null || echo "  No WhatsApp activity yet"

    echo ""
    echo "Recent Telegram Activity:"
    echo "─────────────────────────"
    tail -n 5 "$LOG_DIR/telegram.log" 2>/dev/null || echo "  No Telegram activity yet"

    echo ""
    echo "Logs:"
    echo "  Telegram: tail -f $LOG_DIR/telegram.log"
    echo "  Daemon: tail -f $LOG_DIR/daemon.log"
}

# View logs
logs() {
    case "${1:-telegram}" in
        # WhatsApp disabled
        # whatsapp|wa)
        #     tail -f "$LOG_DIR/whatsapp.log"
        #     ;;
        telegram|tg)
            tail -f "$LOG_DIR/telegram.log"
            ;;
        daemon|all)
            tail -f "$LOG_DIR/daemon.log"
            ;;
        *)
            echo "Usage: $0 logs [telegram|daemon]"
            ;;
    esac
}

case "${1:-}" in
    start)
        start_daemon
        ;;
    stop)
        stop_daemon
        ;;
    restart)
        stop_daemon
        sleep 2
        start_daemon
        ;;
    status)
        status_daemon
        ;;
    send)
        if [ -z "$2" ]; then
            echo "Usage: $0 send <message>"
            exit 1
        fi
        send_message "$2" "cli"
        ;;
    logs)
        logs "$2"
        ;;
    reset)
        echo -e "${YELLOW}🔄 Resetting conversation...${NC}"
        touch "$SCRIPT_DIR/.tinyclaw/reset_flag"
        echo -e "${GREEN}✓ Reset flag set${NC}"
        echo ""
        echo "The next message will start a fresh conversation (without -c)."
        echo "After that, conversation will continue normally."
        ;;
    attach)
        tmux attach -t "$TMUX_SESSION"
        ;;
    *)
        echo -e "${BLUE}TinyClaw Simple - Claude Code + Telegram${NC}"
        echo ""
        echo "Usage: $0 {start|stop|restart|status|send|logs|reset|attach}"
        echo ""
        echo "Commands:"
        echo "  start          Start TinyClaw"
        echo "  stop           Stop all processes"
        echo "  restart        Restart TinyClaw"
        echo "  status         Show current status"
        echo "  send <msg>     Send message to Claude manually"
        echo "  logs [type]    View logs (telegram|daemon|queue)"
        echo "  reset          Reset conversation (next message starts fresh)"
        echo "  attach         Attach to tmux session"
        echo ""
        echo "Examples:"
        echo "  $0 start"
        echo "  $0 status"
        echo "  $0 send 'What time is it?'"
        echo "  $0 reset"
        echo "  $0 logs queue"
        echo ""
        exit 1
        ;;
esac
