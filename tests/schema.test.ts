import { describe, expect, it } from 'vitest';
import {
  extractJsonBlock,
  parseIndexResult,
  parseJsonResult,
  sanitizeExtraction,
} from '../src/core/protocol/schema';

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
  it('接受面向持续维护的 knowledge 条目，并保留必要详情', () => {
    const r = sanitizeExtraction('```json\n' + JSON.stringify({
      knowledge: [{
        time: '2026-09-21', category: '运维故障', topic: 'ERP连接中断',
        content: 'ERP 客户端与服务器连接间歇性中断。',
        details: { cause: '网络环路', solution: '拔掉其中一条网线' },
      }],
    }) + '\n```');
    expect(r).not.toBeNull();
    expect(r!.knowledge).toEqual([{
      time: '2026-09-21', category: '运维故障', topic: 'ERP连接中断',
      content: 'ERP 客户端与服务器连接间歇性中断。',
      details: { cause: '网络环路', solution: '拔掉其中一条网线' },
    }]);
    expect(r!.version).toBe(2);
  });

  it('knowledge 条目缺少分类、主题或内容时触发重新生成', () => {
    expect(sanitizeExtraction('{"knowledge":[{"topic":"缺少分类","content":"内容"}]}')).toBeNull();
    expect(sanitizeExtraction('{"knowledge":[{"category":"事实","topic":"主题"}]}')).toBeNull();
    expect(sanitizeExtraction('{"knowledge":[{"category":"事实","topic":"主题","content":"内容","source":"额外字段"}]}')).toBeNull();
  });

  it('无法解析时返回 null', () => {
    expect(sanitizeExtraction('纯文本')).toBeNull();
    expect(sanitizeExtraction('{"knowledge": 不对')).toBeNull();
  });

  it('结构异常时返回 null，交给引擎重新生成', () => {
    expect(sanitizeExtraction('{"knowledge":"应该是数组"}')).toBeNull();
    expect(sanitizeExtraction('{"knowledge":[{"wrong":"缺少必填字段"}]}')).toBeNull();
    expect(sanitizeExtraction('{"unexpected":[{"value":1}]}')).toBeNull();
    expect(sanitizeExtraction('{"knowledge":[]}')).not.toBeNull();
    expect(sanitizeExtraction('{"knowledge":[],"extra":true}')).toBeNull();
  });
});

describe('parseJsonResult', () => {
  it('保留模型自定义 JSON 结构，不强制清洗成固定分类', () => {
    const raw = '```json\n{"knowledge_entries":[{"title":"ERP重启"}],"meta":{"source":"OA"}}\n```';
    expect(parseJsonResult(raw)).toEqual({
      knowledge_entries: [{ title: 'ERP重启' }],
      meta: { source: 'OA' },
    });
  });

  it('只拒绝无法解析或顶层为标量的回复', () => {
    expect(parseJsonResult('不是 JSON')).toBeNull();
    expect(parseJsonResult('```json\n"文本"\n```')).toBeNull();
    expect(parseJsonResult('[{"title":"有效数组"}]')).toEqual([{ title: '有效数组' }]);
  });
});

describe('parseIndexResult', () => {
  it('只接受可回到原文的索引单元', () => {
    expect(parseIndexResult('```json\n{"units":[{"id":"c1","topic":"登录","sourceHints":["2026-03-01 09:00"]}]}\n```')).toEqual({
      units: [{ id: 'c1', topic: '登录', sourceHints: ['2026-03-01 09:00'] }],
    });
    expect(parseIndexResult('{"units":[{"id":"c1","topic":"登录","sourceHints":[]}]}')).toBeNull();
    expect(parseIndexResult('{"units":[{"id":"c1","topic":"登录"}]}')).toBeNull();
  });
});
