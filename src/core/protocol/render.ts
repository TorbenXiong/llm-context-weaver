import type { ExtractionResult } from './schema';

/** 把最终知识结构渲染成 Markdown 报告（本地确定性渲染，不消耗任何 LLM 请求） */
export function renderKnowledgeMarkdown(r: ExtractionResult, title: string): string {
  const lines: string[] = [`# ${title}`, ''];
  if (r.facts.length > 0) {
    lines.push('## 事实', '');
    for (const i of r.facts) {
      lines.push(`- ${i.text}${i.time ? `（${i.time}）` : ''}${i.confidence ? ` [${i.confidence}]` : ''}`);
    }
    lines.push('');
  }
  if (r.projects.length > 0) {
    lines.push('## 项目', '');
    for (const i of r.projects) {
      lines.push(`- **${i.name}**${i.status ? `（${i.status}）` : ''}${i.description ? `：${i.description}` : ''}`);
    }
    lines.push('');
  }
  if (r.decisions.length > 0) {
    lines.push('## 决策', '');
    for (const i of r.decisions) {
      lines.push(`- ${i.what}${i.why ? ` — 原因：${i.why}` : ''}${i.when ? `（${i.when}）` : ''}`);
    }
    lines.push('');
  }
  if (r.solutions.length > 0) {
    lines.push('## 解决方案', '');
    for (const i of r.solutions) {
      lines.push(`- **问题**：${i.problem}`, `  **方案**：${i.solution}`);
    }
    lines.push('');
  }
  if (r.preferences.length > 0) {
    lines.push('## 偏好', '');
    for (const i of r.preferences) lines.push(`- ${i.topic}：${i.preference}`);
    lines.push('');
  }
  if (r.timeline.length > 0) {
    lines.push('## 时间线', '');
    for (const i of r.timeline) lines.push(`- ${i.time} — ${i.event}`);
    lines.push('');
  }
  if (r.todos.length > 0) {
    lines.push('## 待办', '');
    for (const i of r.todos) {
      lines.push(`- [ ] ${i.task}${i.owner ? `（${i.owner}）` : ''}${i.due ? `，截止：${i.due}` : ''}`);
    }
    lines.push('');
  }
  if (r.openQuestions.length > 0) {
    lines.push('## 未解决的问题', '');
    for (const i of r.openQuestions) lines.push(`- ${i.question}${i.context ? `（${i.context}）` : ''}`);
    lines.push('');
  }
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n') + '\n';
}