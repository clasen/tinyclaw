#!/usr/bin/env node
/**
 * Queue Processor - Handles messages from all channels (WhatsApp, Telegram, etc.)
 * Processes one message at a time to avoid race conditions
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const QUEUE_INCOMING = path.join(SCRIPT_DIR, '.tinyclaw/queue/incoming');
const QUEUE_OUTGOING = path.join(SCRIPT_DIR, '.tinyclaw/queue/outgoing');
const QUEUE_PROCESSING = path.join(SCRIPT_DIR, '.tinyclaw/queue/processing');
const LOG_FILE = path.join(SCRIPT_DIR, '.tinyclaw/logs/queue.log');
const RESET_FLAG = path.join(SCRIPT_DIR, '.tinyclaw/reset_flag');
const ENV_PATH = path.join(SCRIPT_DIR, '.tinyclaw/.env');
const CODEX_OUT_DIR = path.join(SCRIPT_DIR, '.tinyclaw/codex');

// Ensure directories exist
[QUEUE_INCOMING, QUEUE_OUTGOING, QUEUE_PROCESSING, path.dirname(LOG_FILE), CODEX_OUT_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Logger
function log(level, message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(LOG_FILE, logMessage);
}

function readEnvValue(name) {
    if (!fs.existsSync(ENV_PATH)) return null;
    const envContent = fs.readFileSync(ENV_PATH, 'utf8');
    const match = envContent.match(new RegExp(`^${name}=(.+)$`, 'm'));
    return match ? match[1].trim() : null;
}

const CODEX_BIN = process.env.CODEX_BIN || readEnvValue('CODEX_BIN') || 'codex';
const CODEX_MODEL = process.env.CODEX_MODEL || readEnvValue('CODEX_MODEL') || '';
const CODEX_BYPASS = process.env.CODEX_BYPASS || readEnvValue('CODEX_BYPASS') || '1';

function isClaudeLimit(output) {
    if (!output) return false;
    return /you\'?ve hit your limit|rate limit|quota|credits.*(exceeded|exhausted)|resets/i.test(output);
}

function commandExists(cmd) {
    try {
        execSync(`command -v ${cmd}`, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function runClaude(message, continueFlag) {
    try {
        const stdout = execSync(
            `cd "${SCRIPT_DIR}" && claude --dangerously-skip-permissions ${continueFlag}-p "${message.replace(/"/g, '\\"')}"`,
            {
                encoding: "utf-8",
                timeout: 120000, // 2 minute timeout
                maxBuffer: 10 * 1024 * 1024, // 10MB buffer
            },
        );
        if (isClaudeLimit(stdout)) {
            return { ok: false, error: new Error('Claude limit reached'), raw: stdout, limit: true };
        }
        return { ok: true, response: stdout };
    } catch (error) {
        const raw = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
        return { ok: false, error, raw, limit: isClaudeLimit(raw) };
    }
}

function runCodex(message) {
    if (!commandExists(CODEX_BIN)) {
        throw new Error(`Codex CLI not found: ${CODEX_BIN}`);
    }

    const outFile = path.join(CODEX_OUT_DIR, `last_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
    const modelFlag = CODEX_MODEL ? `-m "${CODEX_MODEL.replace(/"/g, '\\"')}"` : '';
    const bypassFlag = CODEX_BYPASS === '1'
        ? '--dangerously-bypass-approvals-and-sandbox'
        : '';

    const cmd = `${CODEX_BIN} exec ${bypassFlag} -C "${SCRIPT_DIR}" -o "${outFile}" ${modelFlag} "${message.replace(/"/g, '\\"')}"`;

    execSync(cmd, {
        encoding: 'utf-8',
        timeout: 180000, // 3 minute timeout
        maxBuffer: 10 * 1024 * 1024,
        stdio: 'ignore'
    });

    const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
    if (!text) {
        throw new Error('Codex returned empty response');
    }
    return text;
}

// Process a single message
async function processMessage(messageFile) {
    const processingFile = path.join(QUEUE_PROCESSING, path.basename(messageFile));

    try {
        // Move to processing to mark as in-progress
        fs.renameSync(messageFile, processingFile);

        // Read message
        const messageData = JSON.parse(fs.readFileSync(processingFile, 'utf8'));
        const { channel, sender, message, timestamp, messageId } = messageData;

        log('INFO', `Processing [${channel}] from ${sender}: ${message.substring(0, 50)}...`);

        // Check if we should reset conversation (start fresh without -c)
        const shouldReset = fs.existsSync(RESET_FLAG);
        const continueFlag = shouldReset ? '' : '-c ';

        if (shouldReset) {
            log('INFO', '🔄 Resetting conversation (starting fresh without -c)');
            fs.unlinkSync(RESET_FLAG);
        }

        // Call Claude (fallback to Codex on failure or limits)
        let response;
        const claudeResult = runClaude(message, continueFlag);
        if (claudeResult.ok) {
            response = claudeResult.response;
        } else {
            const reason = claudeResult.limit ? 'Claude limit reached' : 'Claude error';
            log('WARN', `${reason}. Falling back to Codex.`);
            if (claudeResult.raw) {
                log('ERROR', `Claude error detail: ${claudeResult.raw}`);
            }
            try {
                response = runCodex(message);
                log('INFO', 'Codex fallback succeeded');
            } catch (error) {
                log('ERROR', `Codex error: ${error.message}`);
                response = "Sorry, I encountered an error processing your request.";
            }
        }

        // Clean response
        response = response.trim();

        // Limit response length
        if (response.length > 4000) {
            response = response.substring(0, 3900) + '\n\n[Response truncated...]';
        }

        // Write response to outgoing queue
        const responseData = {
            channel,
            sender,
            message: response,
            originalMessage: message,
            timestamp: Date.now(),
            messageId
        };

        const responseFile = path.join(QUEUE_OUTGOING, `${channel}_${messageId}_${Date.now()}.json`);

        fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2));

        log('INFO', `✓ Response ready [${channel}] ${sender} (${response.length} chars)`);

        // Clean up processing file
        fs.unlinkSync(processingFile);

    } catch (error) {
        log('ERROR', `Processing error: ${error.message}`);

        // Move back to incoming for retry
        if (fs.existsSync(processingFile)) {
            try {
                fs.renameSync(processingFile, messageFile);
            } catch (e) {
                log('ERROR', `Failed to move file back: ${e.message}`);
            }
        }
    }
}

// Main processing loop
async function processQueue() {
    try {
        // Get all files from incoming queue, sorted by timestamp
        const files = fs.readdirSync(QUEUE_INCOMING)
            .filter(f => f.endsWith('.json'))
            .map(f => ({
                name: f,
                path: path.join(QUEUE_INCOMING, f),
                time: fs.statSync(path.join(QUEUE_INCOMING, f)).mtimeMs
            }))
            .sort((a, b) => a.time - b.time);

        if (files.length > 0) {
            log('DEBUG', `Found ${files.length} message(s) in queue`);

            // Process one at a time
            for (const file of files) {
                await processMessage(file.path);
            }
        }
    } catch (error) {
        log('ERROR', `Queue processing error: ${error.message}`);
    }
}

// Main loop
log('INFO', 'Queue processor started');
log('INFO', `Watching: ${QUEUE_INCOMING}`);

// Process queue every 1 second
setInterval(processQueue, 1000);

// Graceful shutdown
process.on('SIGINT', () => {
    log('INFO', 'Shutting down queue processor...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', 'Shutting down queue processor...');
    process.exit(0);
});
