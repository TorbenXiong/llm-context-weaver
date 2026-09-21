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
    expect(skill).toContain('## 知识条目');
    expect(skill).toContain('**运维故障｜ERP连接中断**');
    expect(skill).toContain('连接会间歇性中断。');
    expect(skill).toContain('"cause": "网络环路"');
  });

  it('生成可直接下载的 SKILL.md frontmatter 与知识章节', () => {
    const result: ExtractionResult = { version: EXTRACTION_SCHEMA_VERSION, knowledge: [] };
    result.knowledge.push({
      time: '2026-09-01', category: '流程', topic: '发布流程', content: '需要先完成备份',
    });
    const skill = renderSkillMarkdown(result, 'Atlas 发布知识');
    expect(skill).toContain('name: atlas');
    expect(skill).toContain('description: "Atlas 发布知识的结构化公司知识');
    expect(skill).toContain('## 使用说明');
    expect(skill).toContain('发布流程');
    expect(skill).toContain('需要先完成备份');
  });
});
