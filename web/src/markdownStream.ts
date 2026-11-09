/**
 * While an answer streams in, a bold span can arrive half-finished ("**Needs a"), which markdown
 * renders as literal asterisks until the closing "**" lands. This closes (or briefly hides) the
 * dangling marker in the last block so in-flight text looks settled.
 *
 * Only used for rendering text that is still streaming; the final answer is rendered verbatim.
 */
export function tidyStreamingMarkdown(text: string): string {
  // Inside an unterminated code fence asterisks are literal: leave everything alone.
  if ((text.match(/^ {0,3}(?:```|~~~)/gm)?.length ?? 0) % 2 === 1) return text;

  // Emphasis never spans a blank line, so only the last block can hold the dangling marker.
  const cut = text.lastIndexOf("\n\n") + 1; // 0 when there is no blank line yet
  const head = text.slice(0, cut);
  let tail = text.slice(cut);

  // A lone trailing "*" may be the first half of a "**" split across chunks. Drop it when it is
  // an opener in progress, or when it would be completing an open bold span. A "*" right after
  // a word with no bold open is an italic closer ("*important*") and stays.
  if (/(?<!\*)\*$/.test(tail) && (/(?:^|\s)\*$/.test(tail) || boldMarkers(tail) % 2 === 1)) {
    tail = tail.slice(0, -1);
  }

  if (boldMarkers(tail) % 2 === 1) {
    if (/(?:^|\s)\*\*\s*$/.test(tail)) {
      // The opener just arrived with nothing after it yet: hide it until the text does.
      tail = tail.replace(/\*\*\s*$/, "");
    } else if (!/\*\*\s*$/.test(tail)) {
      // Close the span before any trailing whitespace ("**word **" would not close it).
      tail = tail.replace(/\s*$/, (ws) => `**${ws}`);
    }
  }
  return head + tail;
}

/** Counts "**" delimiters outside inline code (closed spans and an unterminated trailing one). */
function boldMarkers(block: string): number {
  const prose = block.replace(/`[^`\n]*`/g, "").replace(/`[^`\n]*$/, "");
  return prose.match(/\*\*/g)?.length ?? 0;
}
