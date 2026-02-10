/**
 * @module core/format
 * @role Format responses for Telegram (HTML) and chunk long messages.
 * @responsibilities
 *   - Split text into chunks respecting Telegram's 4096 char limit
 *   - Safe HTML sending with plain-text fallback marker
 * @dependencies None
 * @effects None (pure functions)
 * @contract chunkMessage(text) => string[]
 */

const MAX_TELEGRAM_LENGTH = 4096;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function protectTelegramHtmlTags(text: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  const tagPattern = /<\/?(?:b|i|u|s|code|pre|blockquote)>|<a\s+href="[^"]+">|<\/a>/gi;
  const protectedText = text.replace(tagPattern, (tag) => {
    tags.push(tag);
    return `\x00HTMLTAG${tags.length - 1}\x00`;
  });
  return { text: protectedText, tags };
}

/**
 * Convert Markdown (from Claude CLI) to Telegram-safe HTML.
 * Telegram supports: <b>, <i>, <code>, <pre>, <a>, <s>, <u>, <blockquote>
 * Must also escape HTML entities in non-tag content.
 */
export function markdownToTelegramHtml(text: string): string {
  // Step 1: Extract code blocks and links before escaping to protect them
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];
  const links: string[] = [];

  // Preserve already-valid Telegram HTML tags instead of escaping them.
  const protectedHtml = protectTelegramHtmlTags(text);

  // Protect fenced code blocks: ```lang\n...\n``` or ```...```
  let result = protectedHtml.text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    codeBlocks.push(code.trimEnd());
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // Protect inline code: `...`
  result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
    inlineCodes.push(code);
    return `\x00INLINE${inlineCodes.length - 1}\x00`;
  });

  // Protect links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
    links.push(`<a href="${url}">${escapeHtml(linkText)}</a>`);
    return `\x00LINK${links.length - 1}\x00`;
  });

  // Step 2: Now escape HTML entities in the remaining text
  result = escapeHtml(result);

  // Step 3: Convert markdown patterns to HTML tags

  // Bold+Italic: ***text*** or ___text___
  result = result.replace(/\*{3}(.+?)\*{3}/g, "<b><i>$1</i></b>");
  result = result.replace(/_{3}(.+?)_{3}/g, "<b><i>$1</i></b>");

  // Bold: **text** or __text__
  result = result.replace(/\*{2}(.+?)\*{2}/g, "<b>$1</b>");
  result = result.replace(/_{2}(.+?)_{2}/g, "<b>$1</b>");

  // Italic: *text* or _text_ (not inside words for underscore)
  result = result.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<i>$1</i>");
  result = result.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Step 4: Restore protected elements
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, i) => `<pre>${escapeHtml(codeBlocks[+i])}</pre>`);
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_m, i) => `<code>${escapeHtml(inlineCodes[+i])}</code>`);
  result = result.replace(/\x00LINK(\d+)\x00/g, (_m, i) => links[+i]);
  result = result.replace(/\x00HTMLTAG(\d+)\x00/g, (_m, i) => protectedHtml.tags[+i]);

  return result;
}

export function chunkMessage(text: string): string[] {
  if (text.length <= MAX_TELEGRAM_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  // Tags that Telegram supports and we use
  const tagNames = ["pre", "code", "b", "i", "s", "a"];

  while (remaining.length > 0) {
    if (remaining.length <= MAX_TELEGRAM_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", MAX_TELEGRAM_LENGTH);
    if (splitAt === -1 || splitAt < MAX_TELEGRAM_LENGTH * 0.5) {
      splitAt = MAX_TELEGRAM_LENGTH;
    }

    // Check if splitting here would break an HTML tag
    let candidate = remaining.substring(0, splitAt);

    // Find unclosed tags in the candidate chunk
    const openTags: string[] = [];
    const tagRegex = /<\/?([a-z]+)(?:\s[^>]*)?\/?>/gi;
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(candidate)) !== null) {
      const fullTag = match[0];
      const tagName = match[1].toLowerCase();
      if (!tagNames.includes(tagName)) continue;
      if (fullTag.startsWith("</")) {
        // Closing tag - pop if matching
        const idx = openTags.lastIndexOf(tagName);
        if (idx !== -1) openTags.splice(idx, 1);
      } else if (!fullTag.endsWith("/>")) {
        openTags.push(tagName);
      }
    }

    // If there are unclosed tags, close them at end of this chunk and reopen in next
    if (openTags.length > 0) {
      const closingTags = [...openTags].reverse().map(t => `</${t}>`).join("");
      const openingTags = openTags.map(t => `<${t}>`).join("");
      candidate = candidate + closingTags;
      remaining = openingTags + remaining.substring(splitAt).trimStart();
    } else {
      remaining = remaining.substring(splitAt).trimStart();
    }

    chunks.push(candidate);
  }

  return chunks;
}
