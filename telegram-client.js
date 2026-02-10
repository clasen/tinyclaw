#!/usr/bin/env node
/**
 * Telegram Client for TinyClaw
 * Writes messages to queue and reads responses
 * Does NOT call Claude directly - that's handled by queue-processor
 */

const { Bot, GrammyError, HttpError, InputFile } = require('grammy');
const fs = require('fs');
const path = require('path');
const https = require('https');
const OpenAI = require('openai');

const SCRIPT_DIR = __dirname;
const QUEUE_INCOMING = path.join(SCRIPT_DIR, '.tinyclaw/queue/incoming');
const QUEUE_OUTGOING = path.join(SCRIPT_DIR, '.tinyclaw/queue/outgoing');
const LOG_FILE = path.join(SCRIPT_DIR, '.tinyclaw/logs/telegram.log');
const VOICE_TEMP_DIR = path.join(SCRIPT_DIR, '.tinyclaw/voice_temp');

// Ensure directories exist
[QUEUE_INCOMING, QUEUE_OUTGOING, path.dirname(LOG_FILE), VOICE_TEMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Track pending messages (waiting for response)
const pendingMessages = new Map(); // messageId -> {chatId, originalMessageId, timestamp}

// Logger
function log(level, message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(LOG_FILE, logMessage);
}

// Load bot token from environment variable or .env file
let BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
    const envPath = path.join(SCRIPT_DIR, '.tinyclaw/.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const match = envContent.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
        if (match) {
            BOT_TOKEN = match[1].trim();
        }
    }
}

if (!BOT_TOKEN || BOT_TOKEN === 'your_bot_token_here') {
    log('ERROR', 'TELEGRAM_BOT_TOKEN not found. Set it as an environment variable or in .tinyclaw/.env');
    process.exit(1);
}

// Load OpenAI API key for voice transcription
let OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
    const envPath2 = path.join(SCRIPT_DIR, '.tinyclaw/.env');
    if (fs.existsSync(envPath2)) {
        const envContent2 = fs.readFileSync(envPath2, 'utf8');
        const match2 = envContent2.match(/^OPENAI_API_KEY=(.+)$/m);
        if (match2) {
            OPENAI_API_KEY = match2[1].trim();
        }
    }
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
if (openai) {
    log('INFO', 'OpenAI Whisper configured for voice transcription');
} else {
    log('WARN', 'OPENAI_API_KEY not found - voice messages will not be supported');
}

// Initialize Telegram bot
const bot = new Bot(BOT_TOKEN);

// Error handler
bot.catch((err) => {
    const ctx = err.ctx;
    log('ERROR', `Error while handling update ${ctx.update.update_id}:`);
    const e = err.error;
    if (e instanceof GrammyError) {
        log('ERROR', `Request error: ${e.description}`);
    } else if (e instanceof HttpError) {
        log('ERROR', `Could not contact Telegram: ${e}`);
    } else {
        log('ERROR', `Unknown error: ${e}`);
    }
});

// Reset command handler
bot.command('reset', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    log('INFO', 'Reset command received');

    const resetFlagPath = path.join(SCRIPT_DIR, '.tinyclaw/reset_flag');
    fs.writeFileSync(resetFlagPath, 'reset');

    await ctx.reply('Conversation reset! Next message will start a fresh conversation.');
});

// Download a file from Telegram servers
async function downloadTelegramFile(filePath) {
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
        }).on('error', reject);
    });
}

// Transcribe audio using OpenAI Whisper API
async function transcribeVoice(audioBuffer, filename) {
    if (!openai) {
        throw new Error('OpenAI API key not configured');
    }
    const tempPath = path.join(VOICE_TEMP_DIR, filename);
    fs.writeFileSync(tempPath, audioBuffer);
    try {
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempPath),
            model: 'whisper-1',
        });
        return transcription.text;
    } finally {
        try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
    }
}

// Enqueue a message for processing by Claude
function enqueueMessage(ctx, messageText) {
    const sender = ctx.from.first_name
        + (ctx.from.last_name ? ' ' + ctx.from.last_name : '')
        || ctx.from.username
        || String(ctx.from.id);
    const senderId = String(ctx.from.id);
    const messageId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const queueData = {
        channel: 'telegram',
        sender: sender,
        senderId: senderId,
        message: messageText,
        timestamp: Date.now(),
        messageId: messageId
    };

    const queueFile = path.join(QUEUE_INCOMING, `telegram_${messageId}.json`);
    fs.writeFileSync(queueFile, JSON.stringify(queueData, null, 2));

    log('INFO', `Queued message ${messageId}`);

    pendingMessages.set(messageId, {
        chatId: ctx.chat.id,
        originalMessageId: ctx.message.message_id,
        timestamp: Date.now()
    });

    // Clean up old pending messages (older than 5 minutes)
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    for (const [id, data] of pendingMessages.entries()) {
        if (data.timestamp < fiveMinutesAgo) {
            pendingMessages.delete(id);
        }
    }

    return messageId;
}

// Message handler - Write to queue
bot.on('message:text', async (ctx) => {
    try {
        // Skip non-private chats (groups, supergroups, channels)
        if (ctx.chat.type !== 'private') {
            return;
        }

        const messageText = ctx.message.text;

        // Skip empty messages
        if (!messageText || messageText.trim().length === 0) {
            return;
        }

        // Commands are handled separately
        if (messageText.startsWith('/')) {
            return;
        }

        log('INFO', `Message from ${ctx.from.first_name}: ${messageText.substring(0, 50)}...`);

        // Show typing indicator
        await ctx.api.sendChatAction(ctx.chat.id, 'typing');

        enqueueMessage(ctx, messageText);

    } catch (error) {
        log('ERROR', `Message handling error: ${error.message}`);
    }
});

// Voice message handler
bot.on('message:voice', async (ctx) => {
    try {
        if (ctx.chat.type !== 'private') return;

        const voice = ctx.message.voice;
        log('INFO', `Voice message from ${ctx.from.first_name} (${voice.duration}s, ${voice.file_size || '?'} bytes)`);

        await ctx.api.sendChatAction(ctx.chat.id, 'typing');

        if (!openai) {
            await ctx.reply('Los mensajes de voz no están habilitados. Falta configurar OPENAI_API_KEY.');
            return;
        }

        // Download voice file from Telegram
        const file = await ctx.api.getFile(voice.file_id);
        if (!file.file_path) {
            await ctx.reply('No se pudo descargar el audio. Intentá de nuevo.');
            return;
        }

        const audioBuffer = await downloadTelegramFile(file.file_path);

        // Transcribe using Whisper
        let transcribedText;
        try {
            transcribedText = await transcribeVoice(audioBuffer, `voice_${Date.now()}.ogg`);
        } catch (error) {
            log('ERROR', `Transcription failed: ${error.message}`);
            await ctx.reply('No se pudo transcribir el audio. Intentá con un mensaje de texto.');
            return;
        }

        if (!transcribedText || transcribedText.trim().length === 0) {
            await ctx.reply('No se pudo entender el audio (resultado vacío). Intentá de nuevo.');
            return;
        }

        log('INFO', `Transcribed voice: "${transcribedText.substring(0, 80)}..."`);

        enqueueMessage(ctx, `[Voice message transcription]: ${transcribedText}`);

    } catch (error) {
        log('ERROR', `Voice message handling error: ${error.message}`);
    }
});

// Extract file paths from response text and send them as documents
async function sendAttachedFiles(chatId, text) {
    const filePathRegex = /(\/[\w./-]+\.\w{1,10})/gm;
    const matches = [...text.matchAll(filePathRegex)];
    const seen = new Set();
    const sentFiles = [];

    for (const match of matches) {
        const filePath = match[1];
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        try {
            const stat = fs.statSync(filePath);
            // Only send files under 50MB and skip directories
            if (stat.isFile() && stat.size < 50 * 1024 * 1024) {
                await bot.api.sendDocument(chatId, new InputFile(filePath));
                sentFiles.push(filePath);
                log('INFO', `Sent file: ${filePath}`);
            }
        } catch (e) {
            // File doesn't exist or can't be read, skip
        }
    }
    return sentFiles;
}

// Send response handling Telegram's 4096 char limit
async function sendTelegramResponse(chatId, text) {
    const MAX_LENGTH = 4096;

    if (text.length <= MAX_LENGTH) {
        await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } else {
        const chunks = [];
        let remaining = text;
        while (remaining.length > 0) {
            if (remaining.length <= MAX_LENGTH) {
                chunks.push(remaining);
                break;
            }
            let splitAt = remaining.lastIndexOf('\n', MAX_LENGTH);
            if (splitAt === -1 || splitAt < MAX_LENGTH * 0.5) {
                splitAt = MAX_LENGTH;
            }
            chunks.push(remaining.substring(0, splitAt));
            remaining = remaining.substring(splitAt).trimStart();
        }

        for (const chunk of chunks) {
            await bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
        }
    }
}

// Watch for responses in outgoing queue
async function checkOutgoingQueue() {
    try {
        const files = fs.readdirSync(QUEUE_OUTGOING)
            .filter(f => f.startsWith('telegram_') && f.endsWith('.json'));

        for (const file of files) {
            const filePath = path.join(QUEUE_OUTGOING, file);

            try {
                const responseData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const { messageId, message: responseText, sender } = responseData;

                const pending = pendingMessages.get(messageId);
                if (pending) {
                    await sendTelegramResponse(pending.chatId, responseText);
                    await sendAttachedFiles(pending.chatId, responseText);
                    log('INFO', `Sent response to ${sender} (${responseText.length} chars)`);

                    pendingMessages.delete(messageId);
                    fs.unlinkSync(filePath);
                } else {
                    log('WARN', `No pending message for ${messageId}, cleaning up`);
                    fs.unlinkSync(filePath);
                }
            } catch (error) {
                log('ERROR', `Error processing response file ${file}: ${error.message}`);
            }
        }
    } catch (error) {
        log('ERROR', `Outgoing queue error: ${error.message}`);
    }
}

// Check outgoing queue every second
setInterval(checkOutgoingQueue, 1000);

// Graceful shutdown
process.on('SIGINT', () => {
    log('INFO', 'Shutting down Telegram client...');
    bot.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', 'Shutting down Telegram client...');
    bot.stop();
    process.exit(0);
});

// Start bot
log('INFO', 'Starting Telegram client...');
bot.start({
    onStart: (botInfo) => {
        log('INFO', `Telegram bot connected as @${botInfo.username}`);
        log('INFO', 'Listening for messages...');
    }
});
