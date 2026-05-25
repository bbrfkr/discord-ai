/** Discord の1メッセージ上限（2000文字）。 */
export const DISCORD_MAX_MESSAGE = 2000;

/**
 * 長文を Discord の文字数上限以内のチャンクに分割する。
 * できるだけ改行で区切り、1行が長すぎる場合は強制的に切る。
 */
export function splitForDiscord(
  text: string,
  limit = DISCORD_MAX_MESSAGE,
): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let current = "";

  for (const line of trimmed.split("\n")) {
    // 1行が上限を超える場合は、その行を limit ごとに分割。
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/** メッセージ本文からスレッド名（最大 maxLen 文字）を作る。 */
export function deriveThreadName(content: string, maxLen = 80): string {
  const firstLine = content.trim().split("\n")[0] ?? "";
  const name = firstLine.slice(0, maxLen).trim();
  return name.length > 0 ? name : "AI chat";
}
