import { describe, expect, it } from 'vitest';
import {
  extractJsonBlock,
  parseFormatPlan,
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
    expect(r!.version).toBe(3);
  });

  it('knowledge 条目缺少分类、主题或内容时触发重新生成', () => {
    expect(sanitizeExtraction('{"knowledge":[{"topic":"缺少分类","content":"内容"}]}')).toBeNull();
    expect(sanitizeExtraction('{"knowledge":[{"category":"事实","topic":"主题"}]}')).toBeNull();
    expect(sanitizeExtraction('{"knowledge":[{"category":"事实","topic":"主题","content":"内容","source":"额外字段"}]}')).toBeNull();
  });

  it('保留人员实体和知识关联人员，不生成审核字段', () => {
    const r = sanitizeExtraction(JSON.stringify({
      people: [{ name: '熊自兴', role: '负责人', responsibilities: ['AI 平台集成'] }],
      knowledge: [{
        category: '项目计划', topic: 'AI 平台集成', content: '负责集成 Skill 模块。',
        people: ['熊自兴'],
      }],
    }));
    expect(r).toEqual({
      version: 3,
      people: [{ name: '熊自兴', role: '负责人', responsibilities: ['AI 平台集成'] }],
      knowledge: [{
        category: '项目计划', topic: 'AI 平台集成', content: '负责集成 Skill 模块。',
        people: ['熊自兴'],
      }],
    });
  });

  it('兼容旧结果中的 review 字段，但不把它带入新结果', () => {
    const r = sanitizeExtraction(JSON.stringify({
      knowledge: [{
        category: '流程', topic: '接口联调', content: '先各自测通再联调。',
        review: { owner: '熊自兴', status: 'unreviewed' },
      }],
    }));
    expect(r?.knowledge[0]).toEqual({
      category: '流程', topic: '接口联调', content: '先各自测通再联调。',
    });
  });

  it('移除凭证和登录操作句子，但保留同条中的普通规则并脱敏电话号码', () => {
    const r = sanitizeExtraction(JSON.stringify({
      knowledge: [
        { category: '流程', topic: '会员规则', content: '每月集中申请和充值。登录时使用邮箱密码和验证码。' },
        { category: '规则', topic: '班车联系', content: '需要时联系司机 18637488093。' },
        { category: '规则', topic: '安全带', content: '上车后系好安全带。' },
      ],
    }));
    expect(r?.knowledge).toEqual([
      { category: '流程', topic: '会员规则', content: '每月集中申请和充值。' },
      { category: '规则', topic: '班车联系', content: '需要时联系司机 [敏感信息已脱敏]。' },
      { category: '规则', topic: '安全带', content: '上车后系好安全带。' },
    ]);
  });

  it('不会从详情键名泄露 Session 或 Token 等敏感字段', () => {
    const r = sanitizeExtraction(JSON.stringify({
      knowledge: [{
        category: '系统集成', topic: '统一认证', content: 'OA 与 AI 平台使用统一认证中心。',
        details: {
          session生成步骤: '复制页面代码发送给充值人员',
          token: 'abc123',
          认证方式: '统一认证平台',
        },
      }],
    }));
    expect(r?.knowledge[0]?.details).toEqual({ 认证方式: '统一认证平台' });
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

describe('parseFormatPlan', () => {
  it('接受动态分类、同义名称和统一规则', () => {
    expect(parseFormatPlan(JSON.stringify({
      categories: [{ name: '系统运维', meaning: '故障与维护', aliases: ['系统功能'] }],
      rules: { time: 'YYYY-MM-DD', topic: '简短名词', merge: '仅合并重复项' },
    }))).toEqual({
      version: 1,
      categories: [{ name: '系统运维', meaning: '故障与维护', aliases: ['系统功能'] }],
      rules: { time: 'YYYY-MM-DD', topic: '简短名词', merge: '仅合并重复项' },
    });
  });

  it('缺少分类样本或规则时拒绝，触发重新生成', () => {
    expect(parseFormatPlan('{"categories":[],"rules":{"time":"YYYY-MM-DD"}}')).toBeNull();
    expect(parseFormatPlan('{"categories":[{"name":"流程"}],"rules":{}}')).toBeNull();
  });
});
