export interface ChunkOptions {
  /** 软上限：按行边界贪心装填，尽量不超过该值 */
  maxChars: number;
  /** 硬上限：单行超过时强制按长度截断 */
  hardMaxChars: number;
}

/**
 * 面向聊天记录的分块：统一换行符 → 超长行硬截 → 按行贪心装填。
 * 不做重叠窗口（避免同一事实被提取两次），截断可能发生在会话边界之间，
 * 由提炼模型的容错与归并阶段吸收。
 */
export function splitIntoChunks(text: string, opts: ChunkOptions): string[] {
  const { maxChars, hardMaxChars } = opts;
  if (maxChars <= 0 || hardMaxChars < maxChars) throw new Error('invalid chunk options');
  const normalized = text.replace(/\r\n?/g, '\n');

  const segments: string[] = [];
  for (const line of normalized.split('\n')) {
    if (line.length <= hardMaxChars) {
      segments.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += hardMaxChars) segments.push(line.slice(i, i + hardMaxChars));
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