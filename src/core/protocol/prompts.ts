/** 各阶段提示词模板。模板属于核心层资产，但每个任务可在创建前编辑并随任务保存。 */

import type { JobConfig, PromptTemplateSet } from '../types';
import { parseFormatPlan } from './schema';

export interface MarkerParts {
  jobShort: string;
  kind: 'index' | 'extract' | 'format' | 'normalize' | 'reduce';
  ref: string;
  attempt: number;
}

/** 提示词构建兼容旧任务：未保存模板时自动使用通用默认模板。 */
export type PromptOptions = Pick<JobConfig, 'taskKind' | 'taskInstruction'> & {
  promptTemplates?: Partial<PromptTemplateSet>;
  /** 当前生效的动态格式规范；后续阶段优先沿用后置规范。 */
  formatPlan?: string;
};

const genericRequirements = '以用户目标决定处理范围和详略；只使用输入中有依据的信息；目标要求归纳或建议时，区分原文事实与模型归纳，并保留必要依据；不得补写输入不存在的事实；只输出本阶段要求的结果；除索引阶段外，不要返回空对象、空数组或仅包含空数组的结果；输入有相关依据时必须保留至少一条有实际内容的条目；过滤密码、Token、Cookie、Session、验证码、私密链接、账号密码和可直接用于登录或充值的操作细节';

/** 默认模板只保留通用编排约束，具体业务要求全部来自 {{task}}。 */
export const DEFAULT_PROMPT_TEMPLATES: PromptTemplateSet = {
  index: `{{marker}}
阶段：目标相关索引
目标：{{task}}
输出：JSON代码块，key 使用英文；仅遵循程序定位契约，不代表业务分类。结构为 {"units":[{"id":"{{chunkRef}}-1","topic":"内容","sourceHints":["原文定位信息"]}]}
通用约束：{{generic}}
阶段约束：只识别与目标相关的事实、线索或证据位置，不生成最终结论；长期或重复模式保留多处可定位线索；没有相关内容时 units 为空数组。

格式规范（后续沿用）
{{formatPlan}}

【原始分块 {{chunkRef}}】
{{input}}`,
  extract: `{{marker}}
阶段：目标处理
目标：{{task}}
输出：{{format}}
通用约束：{{generic}}
阶段约束：索引仅用于定位，所有结论回到原文核验；按目标区分直接事实、归纳判断和建议；当前分块证据不足时只保留事实或线索，不下全局结论。

格式规范（后续沿用）
{{formatPlan}}

【相关内容索引】
{{index}}

【原始分块】
{{input}}`,
  format: `{{marker}}
阶段：动态格式规范
目标：{{task}}
输出：JSON代码块，key 使用英文；只输出格式规范，不输出结果条目。以下结构仅用于程序保存规范，分类名称、规则内容和输出形态必须根据用户目标与样本生成：{"categories":[{"name":"分类名称","meaning":"分类含义","aliases":["同义名称"]}],"rules":{"time":"时间规则","topic":"主题规则","content":"内容规则","details":"详情与依据规则","merge":"重复、差异与冲突规则"},"output":{"mode":"knowledge 或 json","topLevelKey":"需要时填写顶层 key","itemFields":["需要时填写条目字段"],"description":"输出形态说明"}}
通用约束：{{generic}}
阶段约束：以用户目标为分类依据，从样本归纳实际出现的主题和字段写法；不套用固定领域分类表；规范须区分事实、归纳判断和建议，并要求保留相应依据；不能添加样本中不存在的事实。

【各提炼会话样本】
{{samples}}`,
  normalize: `{{marker}}
阶段：按规范统一格式
目标：{{task}}
输出：{{format}}
通用约束：{{generic}}
阶段约束：按规范统一写法；保留事实、归纳判断、建议及其依据；只合并确实重复的条目，不丢失场景差异、反例和独有信息；不得补写输入没有的事实。

首次格式规范（作为目标约束）
{{formatPlan}}

【动态格式规范】
{{plan}}

【待统一结果】
{{results}}`,
  reduce: `{{marker}}
阶段：{{stage}}
目标：{{task}}
输出：{{format}}
通用约束：{{generic}}
阶段约束：围绕用户目标整合各片段；合并确实重复的条目，保留不同场景、时间、反例、冲突和证据；跨片段归纳只能基于多处可追溯依据，建议需对应已证实的问题或模式；不得补写输入不存在的信息；{{finalRule}}

格式规范（后续沿用）
{{formatPlan}}

{{results}}`,
};

export function formatMarker(p: MarkerParts): string {
  return `[LCW job=${p.jobShort} kind=${p.kind} ref=${p.ref} attempt=${p.attempt}]`;
}

export const MARKER_PATTERN = /\[LCW job=([\w-]+) kind=(index|extract|format|normalize|reduce) ref=([\w.-]+) attempt=(\d+)\]/;

function primaryTask(options: PromptOptions): string {
  const instruction = options.taskInstruction.trim();
  if (instruction) return instruction;
  return options.taskKind === 'knowledge' ? '处理输入并提取目标所需结果。' : '处理输入并输出结果。';
}

function outputFormat(options: PromptOptions): string {
  if (options.taskKind === 'custom') return '按用户要求输出，不额外限定结构';
  const plan = options.formatPlan ? parseFormatPlan(options.formatPlan) : null;
  if (plan?.output?.mode === 'json') {
    const details = [
      plan.output.topLevelKey ? `顶层 key 为 ${plan.output.topLevelKey}` : '',
      plan.output.itemFields?.length ? `条目字段包括 ${plan.output.itemFields.join('、')}` : '',
      plan.output.description ?? '',
    ].filter(Boolean).join('；');
    return `JSON代码块，按动态格式规范输出任务专属 JSON${details ? `（${details}）` : ''}；不要改回固定 knowledge 结构`;
  }
  return 'JSON代码块。以下是仅用于程序归档的统一结果契约，不是业务领域示例：顶层使用 knowledge 数组；每条记录至少包含 category、topic、content，字段内容、分类和详略完全由用户目标决定，可按目标需要填写 time、details、people；不要套用预设领域分类，也不要添加其他顶层 key';
}

function template(options: PromptOptions, key: keyof PromptTemplateSet): string {
  const value = options.promptTemplates?.[key];
  return typeof value === 'string' && value.trim() ? value : DEFAULT_PROMPT_TEMPLATES[key];
}

function render(templateText: string, values: Record<string, string>): string {
  return templateText.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_match, key: string) => values[key] ?? '');
}

function commonValues(options: PromptOptions, marker: string): Record<string, string> {
  return {
    marker,
    task: primaryTask(options),
    generic: genericRequirements,
    format: outputFormat(options),
    formatPlan: options.formatPlan?.trim() || '（尚未生成；本阶段先按用户目标组织结果）',
  };
}

export function buildExtractionPrompt(marker: string, chunkText: string, options: PromptOptions): string {
  return render(template(options, 'extract'), {
    ...commonValues(options, marker),
    input: chunkText,
    index: '（直接处理模式，无相关索引）',
  });
}

export function buildIndexPrompt(marker: string, chunkRef: string, chunkText: string, options: PromptOptions): string {
  return render(template(options, 'index'), { ...commonValues(options, marker), chunkRef, input: chunkText });
}

export function buildDistillationPrompt(marker: string, chunkText: string, indexResult: string, options: PromptOptions): string {
  return render(template(options, 'extract'), {
    ...commonValues(options, marker),
    input: chunkText,
    index: indexResult,
  });
}

export function buildReducePrompt(marker: string, inputs: string[], options: PromptOptions, final = false): string {
  const joined = inputs.map((text, index) => `【片段 ${index + 1}】\n${text}`).join('\n\n');
  return render(template(options, 'reduce'), {
    ...commonValues(options, marker),
    stage: final ? '最终交付' : '中间归并',
    finalRule: final ? '输出覆盖目标各方面且可直接交付的结果' : '保留最终归并所需的独有信息和依据',
    results: joined,
  });
}

export function buildFormatPlanPrompt(marker: string, samples: string[], options: PromptOptions): string {
  return render(template(options, 'format'), {
    ...commonValues(options, marker),
    samples: samples.map((sample, index) => `【样本 ${index + 1}】\n${sample}`).join('\n\n'),
  });
}

export function buildNormalizePrompt(marker: string, plan: string, inputs: string[], options: PromptOptions): string {
  return render(template(options, 'normalize'), {
    ...commonValues(options, marker),
    plan,
    results: inputs.map((input, index) => `【结果 ${index + 1}】\n${input}`).join('\n\n'),
  });
}
