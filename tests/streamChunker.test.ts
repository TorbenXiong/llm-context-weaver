import { describe, expect, it } from 'vitest';
import { splitIntoChunks } from '../src/core/chunking/chunker';
import { streamBlobChunks } from '../src/core/chunking/streamChunker';

async function collect(blob: Blob, options: { maxChars: number; hardMaxChars: number }): Promise<string[]> {
  const output: string[] = [];
  for await (const chunk of streamBlobChunks(blob, options)) output.push(chunk);
  return output;
}

describe('streamBlobChunks', () => {
  it('与内存分块在 CRLF、Unicode 和超长行上保持一致', async () => {
    const text = `甲乙\r\n${'🙂'.repeat(40)}\r单独 CR\n尾行`;
    const options = { maxChars: 20, hardMaxChars: 30 };
    expect(await collect(new Blob([text]), options)).toEqual(splitIntoChunks(text, options));
  });

  it('空白文件不产生 Chunk', async () => {
    expect(await collect(new Blob([' \r\n\r\n']), { maxChars: 20, hardMaxChars: 30 })).toEqual([]);
  });

  it('无换行超长输入持续按硬上限切分', async () => {
    const options = { maxChars: 16_000, hardMaxChars: 60_000 };
    const text = 'x'.repeat(1_000_123);
    const chunks = await collect(new Blob([text]), options);
    expect(chunks).toEqual(splitIntoChunks(text, options));
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(options.hardMaxChars);
  });
});
