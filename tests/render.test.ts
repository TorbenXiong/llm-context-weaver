import { describe, expect, it } from 'vitest';
import { renderSkillMarkdown } from '../src/core/protocol/render';
import { EXTRACTION_SCHEMA_VERSION, type ExtractionResult } from '../src/core/protocol/schema';

describe('renderSkillMarkdown', () => {
  it('优先渲染统一知识条目的时间、分类、主题、内容和必要详情', () => {
    const result: ExtractionResult = { version: EXTRACTION_SCHEMA_VERSION, knowledge: [] };
    result.knowledge.push({
      time: '2026-09-21', category: '运维故障', topic: 'ERP连接中断',
      content: '连接会间歇性中断。', details: { cause: '网络环路' },
    });
    const skill = renderSkillMarkdown(result, '运维知识');
    expect(skill).toContain('## 提取结果');
    expect(skill).toContain('**运维故障｜ERP连接中断**');
    expect(skill).toContain('连接会间歇性中断。');
    expect(skill).toContain('cause：网络环路');
  });

  it('统一显示 ISO 时间戳和详情键值格式', () => {
    const result: ExtractionResult = {
      version: EXTRACTION_SCHEMA_VERSION,
      knowledge: [{
        time: '2026-07-08T02:06:43Z', category: '规则规范', topic: '打卡规则', content: '当天处理。',
        details: { 时段: '当天', 次数: 2, 条件: ['A', 'B'] },
      }],
    };
    const skill = renderSkillMarkdown(result, '考勤知识');
    expect(skill).toContain('（2026-07-08）');
    expect(skill).toContain('时段：当天');
    expect(skill).toContain('条件：A、B');
    expect(skill).not.toContain('T02:06:43Z');
  });

  it('渲染人员和知识关联', () => {
    const result: ExtractionResult = {
      version: EXTRACTION_SCHEMA_VERSION,
      people: [{ name: '熊自兴', role: '负责人' }],
      knowledge: [{
        category: '项目计划', topic: 'AI 平台集成', content: '负责集成 Skill。',
        people: ['熊自兴'],
      }],
    };
    const skill = renderSkillMarkdown(result, 'AI 平台知识');
    expect(skill).toContain('## 人员');
    expect(skill).toContain('熊自兴');
    expect(skill).toContain('相关人员');
    expect(skill).not.toContain('审核');
  });

  it('生成可直接下载的 SKILL.md frontmatter 与知识章节', () => {
    const result: ExtractionResult = { version: EXTRACTION_SCHEMA_VERSION, knowledge: [] };
    result.knowledge.push({
      time: '2026-09-01', category: '流程', topic: '发布流程', content: '需要先完成备份',
    });
    const skill = renderSkillMarkdown(result, 'Atlas 发布知识');
    expect(skill).toContain('name: atlas');
    expect(skill).toContain('description: "Atlas 发布知识的结构化结果');
    expect(skill).toContain('## 使用说明');
    expect(skill).toContain('发布流程');
    expect(skill).toContain('需要先完成备份');
  });

  it('个人成长任务导出的 Markdown 和 Skill 保留原始目标，不预设企业身份', () => {
    const result: ExtractionResult = {
      version: EXTRACTION_SCHEMA_VERSION,
      knowledge: [{
        category: '沟通方式', topic: '反馈偏好', content: '多次要求先给结论。',
        details: { 类型: '归纳判断', 依据: '多段对话均明确要求先给结论' },
      }],
    };
    const goal = '提取用户画像与个人成长建议；区分事实与归纳判断';
    const skill = renderSkillMarkdown(result, '个人成长', goal);
    expect(skill).toContain(`原任务目标：${goal}`);
    expect(skill).toContain('依据：多段对话均明确要求先给结论');
    expect(skill).not.toContain('公司内部知识助手');
  });
});
