/**
 * 提炼 / 归并 prompt 模板。属于核心层资产，所有 Provider 共用同一套输出契约；
 * 每条 prompt 都带 marker 头，恢复后 Provider 可凭 marker 定位对应回复。
 */

export interface MarkerParts {
  jobShort: string;
  kind: 'extract' | 'reduce';
  ref: string;
  attempt: number;
}

export function formatMarker(p: MarkerParts): string {
  return `[LCW job=${p.jobShort} kind=${p.kind} ref=${p.ref} attempt=${p.attempt}]`;
}

export const MARKER_PATTERN = /\[LCW job=([\w-]+) kind=(extract|reduce) ref=([\w.-]+) attempt=(\d+)\]/;

const SCHEMA_DOC = `{
  "facts": [{"text":"确定的事实","time":"时间表述(可选)","confidence":"high|medium|low(可选)"}],
  "projects": [{"name":"项目名","description":"简介(可选)","status":"状态(可选)"}],
  "decisions": [{"what":"决策内容","why":"原因(可选)","when":"时间(可选)"}],
  "solutions": [{"problem":"问题","solution":"解决方案"}],
  "preferences": [{"topic":"主题","preference":"偏好内容"}],
  "timeline": [{"time":"时间","event":"事件"}],
  "todos": [{"task":"待办事项","owner":"负责人(可选)","due":"截止时间(可选)"}],
  "openQuestions": [{"question":"未解决的问题","context":"背景(可选)"}]
}`;

export function buildExtractionPrompt(marker: string, chunkText: string): string {
  return `${marker}
你是一个结构化知识提炼器。请从下面的【聊天记录片段】中提取结构化知识。

要求：
1. 只输出一个 \`\`\`json 代码块，不要输出任何解释、前言或其他文字。
2. JSON 严格使用以下 schema（所有顶层字段都必须出现，没有内容时用空数组 []）：
${SCHEMA_DOC}
3. time / when / due 字段保留原文中的时间表述，不要编造或换算。
4. 只提取片段中真实存在的信息，不要推测；不确定的信息不要写入。

【聊天记录片段】
${chunkText}`;
}

export function buildReducePrompt(marker: string, inputs: string[]): string {
  const joined = inputs.map((t, i) => `【片段 ${i + 1}】\n${t}`).join('\n\n');
  return `${marker}
下面是多个按同一 schema 提取的【结构化知识片段】（JSON）。请把它们合并为一个 JSON：

1. 语义级去重：内容相同的条目只保留一条，confidence 取较高者。
2. 不丢失任何独有信息；相互冲突的事实都保留。
3. timeline 按时间先后排序。
4. 只输出一个 \`\`\`json 代码块，schema 与输入完全一致，不要输出其他文字。

schema：
${SCHEMA_DOC}

${joined}`;
}
