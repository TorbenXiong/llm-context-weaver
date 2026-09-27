import { DEFAULT_JOB_CONFIG, type JobConfig, type PipelineMode, type TaskKind } from '../types';
import { DEFAULT_PROMPT_TEMPLATES } from '../protocol/prompts';

export interface SmartDefaults {
  maxChunkChars: number;
  fanIn: number;
  sendDelayMs: number;
  generationTimeoutMs: number;
  explanation: string;
}

function promptTemplateOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/** 仅对明确的文本变换要求使用自由文本；其余目标保留结构化结果契约。 */
export function inferTaskKind(instruction: string): TaskKind {
  const goal = instruction.trim();
  if (/提取|抽取|归纳|梳理|识别|结构化|分类|整理|总结/.test(goal)) {
    return 'knowledge';
  }
  if (/翻译|译成|译为|改写|重写|润色|校对|纠错|扩写|续写|转写|仿写|写成|写一篇|生成.{0,8}(文章|邮件|文案|脚本)/.test(goal)) {
    return 'custom';
  }
  return 'knowledge';
}

/** 索引只在结构化任务需要跨多个原文分块定位依据时启用。 */
export function inferPipelineMode(taskKind: TaskKind, chunkCount: number): PipelineMode {
  return taskKind === 'knowledge' && chunkCount > 1 ? 'staged' : 'direct';
}

/**
 * 根据输入规模给出吞吐优先的起始参数。分块越多，网页会话、对账和输入/输出量冷却的
 * 固定开销越高，因此输入变大时逐步增大单块；同时保留 384k 的软上限，给提示词、
 * 模型输出和网页生成状态留出余量。它只负责建议，不改变已保存的 JobConfig，
 * 用户仍可在高级参数中覆盖任意一项。
 */
export function recommendJobConfig(inputChars: number): SmartDefaults {
  const size = Math.max(0, inputChars);
  if (size >= 10_000_000) {
    return {
      maxChunkChars: 512_000,
      fanIn: 16,
      sendDelayMs: 2_000,
      generationTimeoutMs: 15 * 60_000,
      explanation: '10M 以上输入：采用最大吞吐分块并延长单次超时，显著减少网页会话和冷却次数。',
    };
  }
  if (size >= 5_000_000) {
    return {
      maxChunkChars: 384_000,
      fanIn: 16,
      sendDelayMs: 2_000,
      generationTimeoutMs: 15 * 60_000,
      explanation: '超大输入：采用高吞吐大分块并延长单次超时，显著减少网页会话和冷却次数。',
    };
  }
  if (size >= 1_000_000) {
    return {
      maxChunkChars: 256_000,
      fanIn: 12,
      sendDelayMs: 1_800,
      generationTimeoutMs: 12 * 60_000,
      explanation: '大输入：采用较大分块并延长单次超时，降低总会话数。',
    };
  }
  if (size >= 200_000) {
    return {
      maxChunkChars: 96_000,
      fanIn: 10,
      sendDelayMs: 1_500,
      generationTimeoutMs: 8 * 60_000,
      explanation: '中等输入：适度增大分块，减少网页会话，同时保持单次生成可控。',
    };
  }
  return {
    maxChunkChars: 32_000,
    fanIn: 10,
    sendDelayMs: 1_000,
    generationTimeoutMs: 5 * 60_000,
    explanation: '较小输入：使用较小分块快速完成；聊天记录默认不引入外部搜索。',
  };
}

export function normalizeJobConfig(config: Partial<JobConfig> | undefined): JobConfig {
  const source = config ?? {};
  const { formatNormalization: _legacyOption, ...values } = source as Partial<JobConfig> & { formatNormalization?: boolean };
  return {
    ...DEFAULT_JOB_CONFIG,
    ...values,
    deepThinking: source.deepThinking === true,
    smartSearch: source.smartSearch === true,
    pipelineMode: source.pipelineMode ?? DEFAULT_JOB_CONFIG.pipelineMode,
    taskKind: source.taskKind === 'custom' ? 'custom' : 'knowledge',
    taskInstruction: typeof source.taskInstruction === 'string' ? source.taskInstruction : '',
    promptTemplates: {
      index: promptTemplateOrDefault(source.promptTemplates?.index, DEFAULT_PROMPT_TEMPLATES.index),
      extract: promptTemplateOrDefault(source.promptTemplates?.extract, DEFAULT_PROMPT_TEMPLATES.extract),
      format: promptTemplateOrDefault(source.promptTemplates?.format, DEFAULT_PROMPT_TEMPLATES.format),
      normalize: promptTemplateOrDefault(source.promptTemplates?.normalize, DEFAULT_PROMPT_TEMPLATES.normalize),
      reduce: promptTemplateOrDefault(source.promptTemplates?.reduce, DEFAULT_PROMPT_TEMPLATES.reduce),
    },
    deleteProviderSessionsOnComplete: source.deleteProviderSessionsOnComplete === true,
  };
}
