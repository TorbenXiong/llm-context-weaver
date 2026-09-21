/**
 * 提炼 / 归并 prompt 模板。属于核心层资产，所有 Provider 共用同一套输出契约；
 * 每条 prompt 都带 marker 头，恢复后 Provider 可凭 marker 定位对应回复。
 */

import type { JobConfig } from '../types';

export interface MarkerParts {
  jobShort: string;
  kind: 'index' | 'extract' | 'reduce';
  ref: string;
  attempt: number;
}

export type PromptOptions = Pick<JobConfig, 'taskKind' | 'taskInstruction'>;

/** 面向持续维护的统一知识条目结构。保持紧凑，避免模板掩盖用户目标。 */
export const KNOWLEDGE_JSON_TEMPLATE = `{"knowledge":[{"time":"原文明确的时间(可选)","category":"分类","topic":"主题","content":"核心知识","details":{"必要参数或步骤":"仅必要时填写，否则省略 details"}}]}`;

const knowledgeFormat = `JSON代码块，key 使用英文；只输出 knowledge 数组，不要添加其他顶层 key：\n${KNOWLEDGE_JSON_TEMPLATE}`;
const knowledgeRequirements = '精简，无需与目标无关的内容，需推算的取推算后结果；仅保留目标所需且原文明确的信息；无明确时间就省略 time；details 仅在技术参数、条件或步骤等确有必要时填写；不要输出密码、Token、Cookie、私密链接或敏感原文';

export function formatMarker(p: MarkerParts): string {
  return `[LCW job=${p.jobShort} kind=${p.kind} ref=${p.ref} attempt=${p.attempt}]`;
}

export const MARKER_PATTERN = /\[LCW job=([\w-]+) kind=(index|extract|reduce) ref=([\w.-]+) attempt=(\d+)\]/;

function primaryTask(options: PromptOptions): string {
  const instruction = options.taskInstruction.trim();
  if (instruction) return instruction;
  return options.taskKind === 'knowledge'
    ? '提取输入中值得保留的结构化知识。'
    : '处理输入并输出结果。';
}

export function buildExtractionPrompt(marker: string, chunkText: string, options: PromptOptions): string {
  const task = primaryTask(options);
  if (options.taskKind === 'custom') {
    return `${marker}
目标：${task}
格式：按任务要求输出
要求：精简；只输出处理结果；有时间的要给出原文时间

【输入片段】
${chunkText}`;
  }
  return `${marker}
目标：${task}
格式：${knowledgeFormat}
要求：${knowledgeRequirements}

【输入片段】
${chunkText}`;
}

/** 第一阶段只建立与用户目标直接相关的导航索引，不提前生成最终答案。 */
export function buildIndexPrompt(
  marker: string,
  chunkRef: string,
  chunkText: string,
  options: PromptOptions,
): string {
  return `${marker}
阶段：目标相关索引
目标：${primaryTask(options)}
格式：JSON代码块，key 使用英文
要求：${knowledgeRequirements}
阶段约束：只识别与目标直接相关且原文明确存在的事件或信息单元；不要生成最终答案；每项保留可在原文定位的时间、消息标识或短语；没有相关内容时 units 为空数组
结构：{"units":[{"id":"${chunkRef}-1","topic":"内容","sourceHints":["原文定位信息"]}]}

【原始分块 ${chunkRef}】
${chunkText}`;
}

/** 第二阶段以索引作导航，但所有结论必须回到原文核验。 */
export function buildDistillationPrompt(
  marker: string,
  chunkText: string,
  indexResult: string,
  options: PromptOptions,
): string {
  const task = primaryTask(options);
  const format = options.taskKind === 'custom' ? '按任务要求输出' : knowledgeFormat;
  const requirements = options.taskKind === 'custom'
    ? '只输出处理结果；索引仅用于定位，必须以原文为准；忽略与目标无关的内容'
    : `${knowledgeRequirements}\n阶段约束：只提取与目标直接相关且原文可证实的内容；索引仅用于定位，必须以原文为准`;
  return `${marker}
阶段：目标处理
目标：${task}
格式：${format}
要求：${requirements}

【相关内容索引】
${indexResult}

【原始分块】
${chunkText}`;
}

export function buildReducePrompt(
  marker: string,
  inputs: string[],
  options: PromptOptions,
  final = false,
): string {
  const joined = inputs.map((t, i) => `【片段 ${i + 1}】\n${t}`).join('\n\n');
  const task = primaryTask(options);
  if (options.taskKind === 'custom') {
    return `${marker}
阶段：${final ? '最终交付' : '中间归并'}
目标：${task}
格式：按任务要求输出
要求：精简；合并重复内容并保留差异；不得补写输入中不存在的信息；${final ? '输出可直接交付的完整结果' : '保留后续归并所需信息'}

${joined}`;
  }
  return `${marker}
阶段：${final ? '最终交付' : '中间归并'}
目标：${task}
格式：${knowledgeFormat}
要求：${knowledgeRequirements}
阶段约束：仅保留与目标直接相关的内容；合并重复项，保留冲突与证据；按 category + topic 合并同一主题，保留明确时间和必要详情；不得补写输入中不存在的信息

${joined}`;
}
