# What is Arisa

Arisa is a Bun + TypeScript agent runtime with a two-process architecture: **Daemon** (stable channel I/O) and **Core** (message processing, media, scheduling, CLI routing). Telegram is one access channel, not the identity of the system.

Inspired by the architecture of [`jlia0/tinyclaw`](https://github.com/jlia0/tinyclaw).

Arisa is intentionally dynamic: the project grows as the user builds a relationship with it. Many capabilities are added live during real conversations (for example, Whisper support), so the system evolves through use instead of staying static.

## Security Notice

Arisa can execute actions with operational control over the system where it runs. Before deploying it, make sure you understand and accept the associated security risks. It is strongly recommended to run Arisa in an isolated environment (for example, a Docker container or a dedicated VPS) that does not store sensitive information or critical assets.

## Commands

Requires [Bun](https://bun.sh).
For Bun global installs, use your user environment (do not use `sudo`).
If needed, configure Bun's user-local install directory:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

```bash
bun install -g arisa     # Global install from package registry (recommended)
```

```bash
arisa                    # Foreground daemon mode (Ctrl+C to stop)
arisa start              # Start as service (enables autostart with systemd --user)
arisa stop               # Stop service
arisa status             # Service status
arisa restart            # Restart service
arisa daemon             # Foreground daemon mode (manual/dev)
arisa core               # Foreground core-only mode
arisa dev                # Foreground core watch mode
```


On Linux with `systemd --user`, `arisa start` enables auto-start on reboot. To keep it running even without an active login session:

```bash
sudo loginctl enable-linger "$USER"
```

## Architecture: Daemon + Core

```
Daemon (:51778)                         Core (:51777)
├── Telegram adapter (grammy)           ├── HTTP server /message, /health
├── HTTP server /send (for scheduler)   ├── Claude CLI with model routing
├── Bridge: HTTP client to Core         ├── Media: voice (Whisper), vision, speech (ElevenLabs)
├── Lifecycle: spawn Core --watch       ├── Scheduler (croner)
└── In-memory queue if Core is down     ├── Format: HTML + chunking
                                        └── File detection in responses
```

**Message flow:**
1. Telegram → Daemon receives message (text/voice/photo)
2. Daemon → POST Core:51777/message (media as base64)
3. Core processes media → routes model → calls `claude CLI` → formats response
4. Core returns response → Daemon sends to Telegram

**Scheduler flow:**
Scheduled task fires → Core POSTs to Daemon:51778/send → Telegram

### Principle of separation

- **Daemon** = Channel I/O only. Receives/sends messages. Never processes content. Stable process that never needs restarting.
- **Core** = Everything else. Media processing, Claude CLI, formatting, scheduling. Runs with `bun --watch` for hot-reload when code changes.

## File Structure

```
src/
├── daemon/
│   ├── index.ts            # Entry: channel + HTTP server + spawn Core
│   ├── channels/
│   │   ├── base.ts         # Re-exports Channel interface
│   │   └── telegram.ts     # Telegram adapter (grammy)
│   ├── bridge.ts           # HTTP client to Core with retry + in-memory queue
│   └── lifecycle.ts        # Spawn Core with --watch, auto-restart
│
├── core/
│   ├── index.ts            # HTTP server with /message and /health endpoints
│   ├── processor.ts        # Executes claude CLI with model routing
│   ├── router.ts           # Selects model (haiku/sonnet/opus) by message pattern
│   ├── media.ts            # Voice transcription (Whisper), image analysis (Vision), speech synthesis (ElevenLabs)
│   ├── scheduler.ts        # Cron + one-time tasks with croner, persists via deepbase
│   ├── format.ts           # Telegram chunking (4096 char limit)
│   ├── file-detector.ts     # Detect file paths in responses for auto-sending
│   └── context.ts          # Manage -c flag and reset_flag
│
└── shared/
    ├── types.ts            # All shared interfaces
    ├── config.ts            # Env vars, ports, paths
    ├── logger.ts           # Logger → .arisa/logs/
    └── db.ts               # Unified persistence layer (deepbase)
```

## Model Routing

The router (`src/core/router.ts`) selects Claude models based on message patterns:
- **Haiku**: Reminders, acknowledgments, simple yes/no
- **Sonnet** (default): General conversation, queries
- **Opus**: Code changes, debugging, complex multi-step tasks

## Bot Commands

Available Telegram bot commands:
- `/reset` — Clear conversation history and start fresh
- `/cancel` — Cancel all scheduled tasks for this chat
- `/claude` — Switch to Claude backend (default)
- `/codex` — Switch to Codex backend
- `/speak <text>` — Generate speech from text using ElevenLabs (requires ELEVENLABS_API_KEY)

## Adding a New Channel

Implement the `Channel` interface from `src/shared/types.ts` and register it in `src/daemon/index.ts`. The interface requires: `connect()`, `onMessage()`, `send()`, `sendFile()`.

## Hooks

Configured in `.claude/settings.json`:
- **SessionStart**: Runs `session-start.sh` — outputs Arisa context reminder
- **PostToolUse** (async): Runs `log-activity.sh` — logs tool usage to `.arisa/logs/activity.log`

## Runtime Data

All runtime data lives under `~/.arisa/` (with automatic migration from legacy project-local `.tinyclaw/` or `.arisa/`):
- `logs/` — per-component log files (core, daemon, telegram, scheduler)
- `db/arisa.json` — unified persistence with deepbase
- `attachments/` — saved media files organized by `{chatId}/`
- `.env` — TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, ELEVENLABS_API_KEY
- `voice_temp/` — temporary directory for voice transcription
- `reset_flag` — conversation reset marker

### Persistence with DeepBase

All persistent data is managed by **deepbase** (`src/shared/db.ts`). Location: `~/.arisa/db/arisa.json`.

| Collection      | Key           | Value type         | Description                              |
|-----------------|---------------|--------------------|------------------------------------------|
| `tasks`         | `task.id`     | `ScheduledTask`    | Cron and one-time scheduled tasks        |
| `authorized`    | `chatId`      | `{ userId }`       | Authorized Telegram chats                |
| `onboarded`     | `chatId`      | `{ userId }`       | Chats that completed onboarding          |
| `queue`         | `message.id`  | queue message      | In-memory queue overflow (Daemon→Core)   |
| `attachments`   | `chatId_file` | `AttachmentRecord` | Metadata for saved media (files on disk) |
| `messages`      | `chatId_msgId`| `MessageRecord`    | Message ledger for reply context         |
| `settings`      | key name      | `{ value }`        | App settings (auth_token, etc.)          |

- **API**: `db.get(collection, key)`, `db.set(collection, key, data)`, `db.del(collection, key)`
- **Helper functions**: `src/shared/db.ts` provides type-safe wrappers per collection

## Response Formatting

Telegram responses are sent with `parse_mode: 'HTML'`. When composing responses that will be sent through Telegram, use HTML formatting instead of Markdown. For example, use `<b>bold</b>` instead of `**bold**`, `<code>inline code</code>` instead of backticks, and `<pre>code block</pre>` instead of triple backticks.

## Workflow Orchestration

### 1. Plan Mode (On Request Only)
- Do NOT enter plan mode automatically — only when the user explicitly asks for it
- If something goes sideways, STOP and re-assess, but don't force plan mode
- When user requests planning: write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update 'tasks/lessons.md' with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests -> then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management
1. **Plan First**: Write plan to 'tasks/todo.md' with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review to 'tasks/todo.md'
6. **Capture Lessons**: Update 'tasks/lessons.md' after corrections

## Voice Messages (ElevenLabs)

When you want to send a voice message to the user, wrap the spoken text in `[VOICE]...[/VOICE]` tags:

```
[VOICE]Hello, this will be converted to audio[/VOICE]
```

- The text inside `[VOICE]` gets synthesized via ElevenLabs and sent as a Telegram voice message
- The `[VOICE]` tags are stripped from the text response — only the audio is sent
- Use it when the user asks you to "hablame", "mandame un audio", "decime con voz", etc.
- Keep voice texts concise — long texts cost more and take longer to generate
- You can combine voice with text: write a text response AND include a `[VOICE]` block

## Core Principles
- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
