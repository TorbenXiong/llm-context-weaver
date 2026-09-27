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
    lines.push('## 提取结果', '');
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

/** 把结构化结果渲染成 Markdown 报告（本地确定性渲染，不消耗任何 LLM 请求） */
export function renderKnowledgeMarkdown(r: ExtractionResult, title: string, taskInstruction = ''): string {
  const goal = taskInstruction.trim();
  return `# ${title}\n\n${goal ? `> 目标：${goal.replace(/\r?\n/g, ' ')}\n\n` : ''}${renderKnowledgeSections(r)}\n`;
}

/** 将结构化结果包装成可复用的 SKILL.md。 */
export function renderSkillMarkdown(r: ExtractionResult, title: string, taskInstruction = ''): string {
  const safeTitle = title.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Structured Results';
  const slug = safeTitle
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'structured-results';
  const description = `${safeTitle}的结构化结果。使用时以原任务目标为准，区分事实与归纳判断，证据不足时明确说明。`;
  const goal = taskInstruction.trim();
  return `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${safeTitle}\n\n## 使用说明\n\n${goal ? `原任务目标：${goal.replace(/\r?\n/g, ' ')}\n\n` : ''}回答或复用下方内容时，以原任务目标为准；保留事实、归纳判断与建议的区别，遇到冲突或依据不足时明确说明。\n\n${renderKnowledgeSections(r)}\n`;
}
