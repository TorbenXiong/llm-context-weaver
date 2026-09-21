export interface ChunkOptions {
  /** 单个 Chunk 的目标字符数；完整段落允许适度超过 */
  maxChars: number;
  /** 流式读取缓冲区的安全上限；必须不小于 maxChars */
  hardMaxChars: number;
}

/** 在最大长度内寻找最靠后的自然边界，避免从词语或句子中间切开。 */
export function naturalBreakPosition(text: string, maxChars: number): number {
  const limit = Math.min(maxChars, text.length);
  if (limit === text.length) return limit;
  const floor = Math.max(1, Math.floor(limit * 0.5));
  for (let index = limit; index >= floor; index--) {
    const ch = text[index - 1];
    if ('。！？!?；;，,、'.includes(ch) || /\s/.test(ch)) return index;
  }
  return limit;
}

/** 只有超过硬护栏时才拆分自然段，软目标只用于寻找更早的边界。 */
export function splitLongSegment(text: string, hardMaxChars: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > hardMaxChars) {
    const cut = naturalBreakPosition(rest, hardMaxChars);
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * 面向聊天记录的分块：统一换行符 → 以行/段落为自然边界贪心装填 →
 * 超长段落优先在句末、标点或空白处向前切分。只有没有自然边界时才按字符截断。
 */
export function splitIntoChunks(text: string, opts: ChunkOptions): string[] {
  const { maxChars, hardMaxChars } = opts;
  if (maxChars <= 0 || hardMaxChars < maxChars) throw new Error('invalid chunk options');
  const normalized = text.replace(/\r\n?/g, '\n');

  const segments: string[] = [];
  for (const line of normalized.split('\n')) {
    if (line.length <= maxChars) segments.push(line);
    else segments.push(...splitLongSegment(line, hardMaxChars));
  }

  const chunks: string[] = [];
  let cur = '';
  const flush = (): void => {
    const t = cur.trimEnd();
    if (t.length > 0) chunks.push(t);
    cur = '';
  };
  for (const seg of segments) {
    const nextLen = cur.length === 0 ? seg.length : cur.length + 1 + seg.length;
    if (cur.length > 0 && (nextLen > maxChars || nextLen > hardMaxChars)) flush();
    if (cur.length === 0 && seg.length === 0) continue; // 跳过块首空行
    cur = cur.length === 0 ? seg : `${cur}\n${seg}`;
    if (cur.length >= hardMaxChars) flush();
  }
  flush();
  return chunks;
}
