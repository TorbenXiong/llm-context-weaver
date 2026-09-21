import { describe, expect, it } from 'vitest';
import { normalizeJobConfig, recommendJobConfig } from '../src/core/config/smartDefaults';
import { buildExtractionPrompt, buildReducePrompt } from '../src/core/protocol/prompts';
import { DEFAULT_JOB_CONFIG } from '../src/core/types';

describe('smart defaults', () => {
  it('深度思考、智能搜索和网页会话自动删除默认关闭', () => {
    expect(DEFAULT_JOB_CONFIG.deepThinking).toBe(false);
    expect(DEFAULT_JOB_CONFIG.smartSearch).toBe(false);
    expect(DEFAULT_JOB_CONFIG.deleteProviderSessionsOnComplete).toBe(false);
  });

  it('按输入规模增大分块以减少网页会话和固定调度开销', () => {
    const small = recommendJobConfig(10_000);
    const medium = recommendJobConfig(300_000);
    const large = recommendJobConfig(2_000_000);
    const huge = recommendJobConfig(6_000_000);
    const massive = recommendJobConfig(10_000_000);
    expect(medium.maxChunkChars).toBeGreaterThan(small.maxChunkChars);
    expect(large.maxChunkChars).toBeGreaterThan(medium.maxChunkChars);
    expect(huge.maxChunkChars).toBeGreaterThan(large.maxChunkChars);
    expect(huge.maxChunkChars).toBeLessThanOrEqual(384_000);
    expect(massive.maxChunkChars).toBe(512_000);
    expect(huge.generationTimeoutMs).toBeGreaterThan(large.generationTimeoutMs);
    expect(huge.fanIn).toBeGreaterThan(small.fanIn);
  });

  it('补齐缺省配置', () => {
    const config = normalizeJobConfig({ maxChunkChars: 12_000 });
    expect(config).toMatchObject({ ...DEFAULT_JOB_CONFIG, maxChunkChars: 12_000 });
  });

  it('保留测试范围配置，并限制在提炼会话而不是归并会话', () => {
    expect(normalizeJobConfig({}).testSessionLimit).toBe(0);
    expect(normalizeJobConfig({ testScope: 'sessions', testSessionLimit: 3 })).toMatchObject({
      testScope: 'sessions', testSessionLimit: 3,
    });
    expect(normalizeJobConfig({ testScope: 'percent', testPercent: 25 })).toMatchObject({
      testScope: 'percent', testPercent: 25,
    });
  });

  it('把用户要求作为目标，并用精简的三段式提示约束输出', () => {
    const prompt = buildExtractionPrompt('marker', 'text', {
      ...DEFAULT_JOB_CONFIG,
      taskInstruction: '提取待办',
    });
    expect(prompt).toContain('目标：提取待办');
    expect(prompt).toContain('格式：JSON代码块，key 使用英文');
    expect(prompt).toContain('要求：精简，无需与目标无关的内容，需推算的取推算后结果');
    expect(prompt).not.toContain('有时间的要给出原文时间');
    expect(prompt).not.toContain('只提取与目标直接相关');
    expect(prompt).not.toContain('其他分类填空数组');
    expect(prompt).not.toContain('JSON 结构');
    expect(prompt).not.toContain('补充任务要求');
    expect(prompt).not.toContain('核心任务（最高优先级）');
    expect(prompt.indexOf('目标：提取待办')).toBeLessThan(prompt.indexOf('【输入片段】'));
  });

  it('自定义处理模式输出普通文本并可继续归并', () => {
    const prompt = buildExtractionPrompt('marker', 'hello', {
      ...DEFAULT_JOB_CONFIG,
      taskKind: 'custom',
      taskInstruction: '翻译成英文',
    });
    expect(prompt).toContain('翻译成英文');
    expect(prompt).toContain('只输出处理结果');
  });

  it('归并阶段保持精简，不附加字段说明', () => {
    const prompt = buildReducePrompt('marker', ['first', 'second'], {
      ...DEFAULT_JOB_CONFIG,
      taskInstruction: '只整理与部署故障有关的解决方案',
    });
    expect(prompt).toContain('目标：只整理与部署故障有关的解决方案');
    expect(prompt).toContain('要求：精简，无需与目标无关的内容，需推算的取推算后结果');
    expect(prompt).toContain('阶段约束：仅保留与目标直接相关的内容；合并重复项，保留冲突与证据');
    expect(prompt).toContain('不得补写输入中不存在的信息');
    expect(prompt).not.toContain('JSON 结构');
    expect(prompt).not.toContain('不丢失任何独有信息');
  });
});
