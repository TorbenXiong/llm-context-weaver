import { naturalBreakPosition, splitLongSegment, type ChunkOptions } from './chunker';

/**
 * 从 Blob.stream() 增量解码并分块。即使输入没有换行，未处理缓冲区也受
 * hardMaxChars 约束，不会把 50MB 文件、完整字符串和 chunks[] 同时留在 UI 中。
 */
export async function* streamBlobChunks(blob: Blob, opts: ChunkOptions): AsyncGenerator<string> {
  const { maxChars, hardMaxChars } = opts;
  if (maxChars <= 0 || hardMaxChars < maxChars) throw new Error('invalid chunk options');
  const reader = blob.stream().getReader();
  const decoder = new TextDecoder();
  let lineBuffer = '';
  let current = '';
  let pendingCarriageReturn = false;

  const appendSegment = (segment: string): string | null => {
    const nextLength = current.length === 0 ? segment.length : current.length + 1 + segment.length;
    if (current.length > 0 && (nextLength > maxChars || nextLength > hardMaxChars)) {
      const ready = current.trimEnd();
      current = segment;
      return ready || null;
    }
    if (current.length === 0 && segment.length === 0) return null;
    current = current.length === 0 ? segment : `${current}\n${segment}`;
    if (current.length >= hardMaxChars) {
      const ready = current.trimEnd();
      current = '';
      return ready || null;
    }
    return null;
  };

  /** 跨 reader chunk 归一化 CRLF / CR；末尾 CR 延迟到下一批以识别 CRLF。 */
  const normalize = (decoded: string, final: boolean): string => {
    let input = decoded;
    let prefix = '';
    if (pendingCarriageReturn) {
      prefix = '\n';
      if (input.startsWith('\n')) input = input.slice(1);
      pendingCarriageReturn = false;
    }
    if (!final && input.endsWith('\r')) {
      input = input.slice(0, -1);
      pendingCarriageReturn = true;
    }
    return prefix + input.replace(/\r\n?/g, '\n');
  };

  const consumeLine = function* (line: string): Generator<string> {
    if (line.length <= hardMaxChars) {
      const ready = appendSegment(line);
      if (ready) yield ready;
      return;
    }
    for (const part of splitLongSegment(line, hardMaxChars)) {
      const ready = appendSegment(part);
      if (ready) yield ready;
    }
  };

  const drain = function* (final: boolean): Generator<string> {
    let newline = lineBuffer.indexOf('\n');
    while (newline >= 0) {
      yield* consumeLine(lineBuffer.slice(0, newline));
      lineBuffer = lineBuffer.slice(newline + 1);
      newline = lineBuffer.indexOf('\n');
    }
    while (lineBuffer.length > hardMaxChars) {
      const cut = naturalBreakPosition(lineBuffer, hardMaxChars);
      const ready = appendSegment(lineBuffer.slice(0, cut));
      if (ready) yield ready;
      lineBuffer = lineBuffer.slice(cut).trimStart();
    }
    if (final && lineBuffer.length > 0) {
      yield* consumeLine(lineBuffer);
      lineBuffer = '';
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      const decoded = decoder.decode(value, { stream: !done });
      lineBuffer += normalize(decoded, done);
      yield* drain(done);
      if (done) break;
    }
    const tail = current.trimEnd();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
