# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is TinyClaw

TinyClaw is a lightweight wrapper around Claude Code that connects messaging channels to a Claude Code session via a file-based queue system. Messages from all channels are processed sequentially through a single queue, preventing race conditions and maintaining shared conversation context.

**Note:** WhatsApp integration is currently disabled. Telegram is the primary (and only active) channel. WhatsApp code remains in the codebase and can be re-enabled by uncommenting the relevant sections in `tinyclaw.sh`.

## Commands

```bash
./tinyclaw.sh start      # Start all components in a tmux session
./tinyclaw.sh stop       # Stop all components
./tinyclaw.sh restart    # Stop + start
./tinyclaw.sh status     # Show process status and recent logs
./tinyclaw.sh send "msg" # Send a message to Claude manually
./tinyclaw.sh reset      # Reset conversation (next message starts without -c flag)
./tinyclaw.sh logs telegram # View logs (telegram|daemon|queue)
./tinyclaw.sh attach     # Attach to tmux session
npm install              # Install Node.js dependencies
```

## Architecture

All channel clients follow the same pattern: they do NOT call Claude directly. Instead, they write JSON files to `.tinyclaw/queue/incoming/` and poll `.tinyclaw/queue/outgoing/` for responses.

**Message flow:**
1. Channel client receives a message and writes `{channel}_{messageId}.json` to `incoming/`
2. `queue-processor.js` polls `incoming/` every 1 second, moves the file to `processing/`, calls `claude --dangerously-skip-permissions -c -p "<message>"`, and writes the response to `outgoing/`
3. Channel client polls `outgoing/` every 1 second, matches response by `messageId`, sends it back to the user, and deletes the file

**Queue file format** (JSON):
```
{ channel, sender, senderId, message, timestamp, messageId }
```

**Key components:**
- `tinyclaw.sh` - Orchestrator. Creates a tmux session with 3 panes (Telegram, Queue Processor, Logs)
- `queue-processor.js` - Single-threaded message processor. Calls Claude via `execSync` with 2-minute timeout. Responses truncated at 4000 chars
- `whatsapp-client.js` - **Disabled.** Uses `whatsapp-web.js` with Puppeteer/LocalAuth. Can be re-enabled in `tinyclaw.sh`
- `telegram-client.js` - **Primary channel.** Uses `grammy` library. Requires `TELEGRAM_BOT_TOKEN` in env or `.tinyclaw/.env`. Supports text, voice messages (via Whisper), and file sending

**Conversation reset:** The `/reset` command (from Telegram) creates a `.tinyclaw/reset_flag` file. The queue processor checks for this flag and omits the `-c` (continue) flag on the next Claude invocation, starting a fresh conversation.

## Hooks

Configured in `.claude/settings.json`:
- **SessionStart**: Runs `session-start.sh` which outputs the TinyClaw context reminder
- **PostToolUse** (async): Runs `log-activity.sh` which logs all tool usage to `.tinyclaw/logs/activity.log`

## Runtime Data

All runtime data lives under `.tinyclaw/` (gitignored):
- `queue/incoming/`, `queue/processing/`, `queue/outgoing/` - message queue directories
- `logs/` - per-component log files (telegram, queue, daemon, activity)
- `whatsapp-session/` - persistent WhatsApp auth data (unused while WhatsApp is disabled)
- `.env` - Telegram bot token and OpenAI API key
- `voice_temp/` - temporary directory for voice message transcription

## Response Formatting

Telegram responses are sent with `parse_mode: 'HTML'`. When composing responses that will be sent through Telegram, use HTML formatting instead of Markdown. For example, use `<b>bold</b>` instead of `**bold**`, `<code>inline code</code>` instead of backticks, and `<pre>code block</pre>` instead of triple backticks.
