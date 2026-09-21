import { describe, expect, it } from 'vitest';
import { splitIntoChunks } from '../src/core/chunking/chunker';

const opts = { maxChars: 20, hardMaxChars: 50 };

describe('splitIntoChunks', () => {
  it('空输入与纯空白输入返回空数组', () => {
    expect(splitIntoChunks('', opts)).toEqual([]);
    expect(splitIntoChunks('  \n\n', opts)).toEqual([]);
  });

  it('参数非法时抛错', () => {
    expect(() => splitIntoChunks('x', { maxChars: 100, hardMaxChars: 50 })).toThrow();
  });

  it('按行边界装填，拼接后内容不丢', () => {
    const lines = ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'ffff', 'gggg', 'hhhh'];
    const text = lines.join('\n');
    const chunks = splitIntoChunks(text, opts);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50);
    expect(chunks.join('\n')).toBe(text);
  });

  it('单行超过硬上限时强制截断', () => {
    const chunks = splitIntoChunks('x'.repeat(120), opts);
    expect(chunks).toEqual(['x'.repeat(50), 'x'.repeat(50), 'x'.repeat(20)]);
  });

  it('软上限尽量不被超过（单行不超硬上限时）', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n');
    const chunks = splitIntoChunks(text, { maxChars: 15, hardMaxChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(20); // 最长行 7 字符 + 换行
  });

  it('完整自然段可以略超软目标，不从段落中间切开', () => {
    const paragraph = '第一句说明背景。第二句说明方案，第三句补充约束。';
    const chunks = splitIntoChunks(paragraph, { maxChars: 12, hardMaxChars: 50 });
    expect(chunks).toEqual([paragraph]);
  });

  it('超过硬上限时优先在标点处拆分', () => {
    const text = `${'前置说明。'.repeat(8)}${'后续内容。'.repeat(8)}`;
    const chunks = splitIntoChunks(text, { maxChars: 20, hardMaxChars: 40 });
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
    expect(chunks.slice(0, -1).every((chunk) => /[。！？!?；;]$/.test(chunk))).toBe(true);
  });

  it('统一 \\r\\n 换行符', () => {
    const chunks = splitIntoChunks('a\r\nb\r\nc', { maxChars: 100, hardMaxChars: 200 });
    expect(chunks).toEqual(['a\nb\nc']);
  });
});
