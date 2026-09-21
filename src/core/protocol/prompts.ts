/**
 * 提炼 / 归并 prompt 模板。属于核心层资产，所有 Provider 共用同一套输出契约；
 * 每条 prompt 都带 marker 头，恢复后 Provider 可凭 marker 定位对应回复。
 */

import type { JobConfig } from '../types';

export interface MarkerParts {
  jobShort: string;
  kind: 'index' | 'extract' | 'format' | 'normalize' | 'reduce';
  ref: string;
  attempt: number;
}

export type PromptOptions = Pick<JobConfig, 'taskKind' | 'taskInstruction'>;

/** 面向持续维护的统一知识条目结构。保持紧凑，避免模板掩盖用户目标。 */
export const KNOWLEDGE_JSON_TEMPLATE = `{"knowledge":[{"time":"原文明确的时间(可选)","category":"分类","topic":"主题","content":"核心知识","details":{"必要参数或步骤":"仅必要时填写，否则省略 details"},"people":["明确相关人员(可选)"]}],"people":[{"name":"明确提到的人员","role":"职责(可选)","department":"部门(可选)","responsibilities":["明确职责(可选)"]}]}`;

const knowledgeFormat = `JSON代码块，key 使用英文；顶层必须有 knowledge，只有原文明确提到人员时才输出 people；不要添加其他顶层 key：\n${KNOWLEDGE_JSON_TEMPLATE}`;
const knowledgeRequirements = '精简，无需与目标无关的内容，需推算的取推算后结果；仅保留目标所需且原文明确的信息；无明确时间就省略 time；time 若为绝对时间只保留 YYYY-MM-DD，原文只有“下周”“月底”等相对表述时原样保留；category 允许根据输入发现新分类，但同一批次中相同含义必须使用同一个简短名称，不要为了填分类而制造无关类别；topic 使用简短名词短语；content 用一至三句说明核心事实；details 仅在技术参数、条件或步骤等确有必要时填写，使用简短的键值对；people 只记录原文明确出现且与知识相关的人员，只有原文明确说明其职责、参与或被指派时才填写，不得根据发言或职位自行推断；审核状态、审核负责人和指派信息不由本任务生成；过滤密码、Token、Cookie、Session、验证码、私密链接、账号密码和可直接用于登录或充值的操作细节';

export function formatMarker(p: MarkerParts): string {
  return `[LCW job=${p.jobShort} kind=${p.kind} ref=${p.ref} attempt=${p.attempt}]`;
}

export const MARKER_PATTERN = /\[LCW job=([\w-]+) kind=(index|extract|format|normalize|reduce) ref=([\w.-]+) attempt=(\d+)\]/;

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

const FORMAT_PLAN_TEMPLATE = `{"categories":[{"name":"分类名称","meaning":"分类含义","aliases":["同义旧名称"]}],"rules":{"time":"时间格式规则","topic":"主题命名规则","content":"内容保留规则","details":"详情键值规则","merge":"重复与冲突合并规则"}}`;

export function buildFormatPlanPrompt(marker: string, samples: string[], options: PromptOptions): string {
  const task = primaryTask(options);
  return `${marker}
阶段：动态格式规范
目标：${task}
格式：JSON代码块，key 使用英文；只输出格式规范，不输出知识内容
要求：根据下方各提炼会话的样本，归纳本任务实际出现的分类、主题和字段写法；允许保留多个真实分类，不要套用固定分类表；为同义分类提供 aliases；规范必须服务于用户目标，不能添加输入样本中不存在的知识；时间、详情和合并规则要简洁明确
结构：${FORMAT_PLAN_TEMPLATE}

【各提炼会话样本】
${samples.map((sample, index) => `【样本 ${index + 1}】\n${sample}`).join('\n\n')}`;
}

export function buildNormalizePrompt(
  marker: string,
  plan: string,
  inputs: string[],
  options: PromptOptions,
): string {
  const task = primaryTask(options);
  return `${marker}
阶段：按规范统一格式
目标：${task}
格式：${knowledgeFormat}
要求：只按格式规范统一 category、topic、time、details 的写法，并合并本批次中明确重复的条目；content、人员和详情中的事实必须来自输入，不得补写、删减或改造事实；未被规范覆盖的新分类可以原样保留；无法确定是否重复时不要合并；不要输出审核或指派字段

【动态格式规范】
${plan}

【待统一结果】
${inputs.map((input, index) => `【结果 ${index + 1}】\n${input}`).join('\n\n')}`;
}
