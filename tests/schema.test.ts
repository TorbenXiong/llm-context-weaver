import { describe, expect, it } from 'vitest';
import { emptyExtraction, extractJsonBlock, mergeExtractions, sanitizeExtraction } from '../src/core/protocol/schema';

describe('extractJsonBlock', () => {
  it('提取 ```json 代码块', () => {
    expect(extractJsonBlock('前言\n```json\n{"a":1}\n```\n后语')).toBe('{"a":1}');
  });

  it('从杂乱文本中做平衡括号扫描（字符串内的括号不计）', () => {
    expect(extractJsonBlock('回答：{"a":"}嵌套{"} 完毕')).toBe('{"a":"}嵌套{"}');
  });

  it('没有 JSON 时返回 null', () => {
    expect(extractJsonBlock('没有任何 JSON')).toBeNull();
  });
});

describe('sanitizeExtraction', () => {
  it('解析、类型纠正并丢弃非法条目', () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        facts: [{ text: 'A' }, { text: '' }, { text: 'B', confidence: 'HIGH', time: '昨天' }, { noText: 1 }],
        todos: [{ task: 'x', owner: 123 }],
        unknownSection: [{ a: 1 }],
      }) +
      '\n```';
    const r = sanitizeExtraction(raw);
    expect(r).not.toBeNull();
    expect(r!.version).toBe(1);
    expect(r!.facts).toHaveLength(2);
    expect(r!.facts[1]).toEqual({ text: 'B', time: '昨天' }); // 非法 confidence 被剔除
    expect(r!.todos[0]).toEqual({ task: 'x', owner: '123' });
    expect(r!.projects).toEqual([]); // 缺失字段补空数组
  });

  it('无法解析时返回 null', () => {
    expect(sanitizeExtraction('纯文本')).toBeNull();
    expect(sanitizeExtraction('{"facts": 不对')).toBeNull();
  });
});

describe('mergeExtractions', () => {
  it('拼接所有分区', () => {
    const a = emptyExtraction();
    a.facts.push({ text: 'A' });
    const b = emptyExtraction();
    b.facts.push({ text: 'B' });
    b.todos.push({ task: 'T' });
    const m = mergeExtractions([a, b]);
    expect(m.facts.map((f) => f.text)).toEqual(['A', 'B']);
    expect(m.todos).toHaveLength(1);
  });
});