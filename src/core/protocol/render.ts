import type { ExtractionResult } from './schema';

function renderKnowledgeSections(r: ExtractionResult): string {
  const lines: string[] = [];
  if (r.knowledge.length > 0) {
    lines.push('## 知识条目', '');
    for (const item of r.knowledge) {
      const when = item.time ? `（${item.time}）` : '';
      lines.push(`- ${when} **${item.category}｜${item.topic}**：${item.content}`.trim());
      if (item.details && Object.keys(item.details).length > 0) {
        lines.push(`  - 详情：${JSON.stringify(item.details, null, 2).replace(/\n/g, '\n    ')}`);
      }
    }
    lines.push('');
  }
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

/** 把最终知识结构渲染成 Markdown 报告（本地确定性渲染，不消耗任何 LLM 请求） */
export function renderKnowledgeMarkdown(r: ExtractionResult, title: string): string {
  return `# ${title}\n\n${renderKnowledgeSections(r)}\n`;
}

/** 将结构化知识包装成可直接放入公司 AI 助手的 SKILL.md。 */
export function renderSkillMarkdown(r: ExtractionResult, title: string): string {
  const safeTitle = title.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Company Knowledge';
  const slug = safeTitle
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'company-knowledge';
  const description = `${safeTitle}的结构化公司知识。回答相关问题时优先依据本 Skill，证据不足时明确说明未知，不得臆造。`;
  return `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${safeTitle}\n\n## 使用说明\n\n你是公司内部知识助手。回答与本主题相关的问题时，优先使用下方已提炼且有原文依据的知识；不要把推测当作事实，遇到冲突或信息不足时明确说明。\n\n${renderKnowledgeSections(r)}\n`;
}
