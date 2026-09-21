import type { ExtractionResult } from './schema';

function normalizeDisplayTime(value: string): string {
  const trimmed = value.trim();
  const iso = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(trimmed);
  if (iso) return iso[1];
  const chinese = /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:.*)?$/.exec(trimmed);
  if (chinese) return `${chinese[1]}-${chinese[2].padStart(2, '0')}-${chinese[3].padStart(2, '0')}`;
  return trimmed;
}

function renderDetailValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(renderDetailValue).join('、');
  return JSON.stringify(value);
}

function renderDetails(details: Record<string, unknown>): string[] {
  return Object.entries(details).map(([key, value]) => `  - ${key}：${renderDetailValue(value)}`);
}

function renderKnowledgeSections(r: ExtractionResult): string {
  const lines: string[] = [];
  if (r.people && r.people.length > 0) {
    lines.push('## 人员', '');
    for (const person of r.people) {
      const role = person.role ? `（${person.role}）` : '';
      const department = person.department ? `，${person.department}` : '';
      const responsibilities = person.responsibilities?.length
        ? `：${person.responsibilities.join('；')}`
        : '';
      lines.push(`- **${person.name}**${role}${department}${responsibilities}`);
    }
    lines.push('');
  }
  if (r.knowledge.length > 0) {
    lines.push('## 知识条目', '');
    for (const item of r.knowledge) {
      const when = item.time ? `（${normalizeDisplayTime(item.time)}）` : '';
      lines.push(`- ${when} **${item.category}｜${item.topic}**：${item.content}`.trim());
      if (item.details && Object.keys(item.details).length > 0) {
        lines.push('  - 详情：');
        lines.push(...renderDetails(item.details));
      }
      if (item.people?.length) lines.push(`  - 相关人员：${item.people.join('、')}`);
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
