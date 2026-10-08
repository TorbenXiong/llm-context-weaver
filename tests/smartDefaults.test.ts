import { describe, expect, it } from 'vitest';
import { inferPipelineMode, inferTaskKind, normalizeJobConfig, recommendJobConfig } from '../src/core/config/smartDefaults';
import { buildDistillationPrompt, buildExtractionPrompt, buildFormatPlanPrompt, buildIndexPrompt, buildNormalizePrompt, buildReducePrompt, DEFAULT_PROMPT_TEMPLATES } from '../src/core/protocol/prompts';
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
    expect(huge.maxChunkChars).toBeGreaterThanOrEqual(large.maxChunkChars);
    expect(huge.maxChunkChars).toBeLessThanOrEqual(64_000);
    expect(massive.maxChunkChars).toBe(64_000);
    expect(huge.generationTimeoutMs).toBeGreaterThan(large.generationTimeoutMs);
    expect(huge.fanIn).toBeLessThanOrEqual(small.fanIn);
  });

  it('补齐缺省配置', () => {
    const config = normalizeJobConfig({ maxChunkChars: 12_000 });
    const { promptTemplates: _defaultTemplates, ...defaultConfig } = DEFAULT_JOB_CONFIG;
    expect(config).toMatchObject({ ...defaultConfig, maxChunkChars: 12_000 });
    expect(config.promptTemplates).toEqual(DEFAULT_PROMPT_TEMPLATES);
    expect(normalizeJobConfig(DEFAULT_JOB_CONFIG).promptTemplates).toEqual(DEFAULT_PROMPT_TEMPLATES);
  });

  it('根据任务要求自动判断结果形式和流程', () => {
    expect(inferTaskKind('翻译成英文并保留 Markdown')).toBe('custom');
    expect(inferTaskKind('提取可复用的故障处理经验')).toBe('knowledge');
    expect(inferPipelineMode('knowledge', 1)).toBe('direct');
    expect(inferPipelineMode('knowledge', 2)).toBe('staged');
    expect(inferPipelineMode('custom', 20)).toBe('direct');
  });

  it('把用户要求作为目标，并使用通用阶段模板', () => {
    const prompt = buildExtractionPrompt('marker', 'text', {
      ...DEFAULT_JOB_CONFIG,
      taskInstruction: '提取待办',
    });
    expect(prompt).toContain('目标：提取待办');
    expect(prompt).toContain('输出：JSON代码块');
    expect(prompt).toContain('仅用于程序归档的统一结果契约');
    expect(prompt).toContain('字段内容、分类和详略完全由用户目标决定');
    expect(prompt).toContain('通用约束：');
    expect(prompt).toContain('阶段约束：');
    expect(prompt).toContain('只使用输入中有依据的信息');
    expect(prompt).not.toContain('用户画像');
    expect(prompt).not.toContain('个人成长');
    expect(prompt).not.toContain('企业聊天记录');
    expect(prompt.indexOf('目标：提取待办')).toBeLessThan(prompt.indexOf('【原始分块】'));
  });

  it('自定义处理模式输出普通文本并可继续归并', () => {
    const prompt = buildExtractionPrompt('marker', 'hello', {
      ...DEFAULT_JOB_CONFIG,
      taskKind: 'custom',
      taskInstruction: '翻译成英文',
    });
    expect(prompt).toContain('翻译成英文');
    expect(prompt).toContain('按用户要求输出，不额外限定结构');
  });

  it('归并阶段保持精简，不附加字段说明', () => {
    const prompt = buildReducePrompt('marker', ['first', 'second'], {
      ...DEFAULT_JOB_CONFIG,
      taskInstruction: '只整理与部署故障有关的解决方案',
    });
    expect(prompt).toContain('目标：只整理与部署故障有关的解决方案');
    expect(prompt).toContain('阶段约束：围绕用户目标整合各片段');
    expect(prompt).toContain('保留不同场景、时间、反例、冲突和证据');
    expect(prompt).toContain('不得补写输入不存在的信息');
    expect(prompt).not.toContain('用户画像');
  });

  it('后续阶段可以沿用前置生成的格式规范', () => {
    const prompt = buildExtractionPrompt('marker', '原文', {
      ...DEFAULT_JOB_CONFIG,
      taskInstruction: '提取目标信息',
      formatPlan: '{"categories":[{"name":"目标分类"}]}',
    });
    expect(prompt).toContain('格式规范（后续沿用）');
    expect(prompt).toContain('目标分类');
  });

  it('动态规范指定 JSON 输出时，后续提示词切换到任务专属形态', () => {
    const prompt = buildExtractionPrompt('marker', '原文', {
      ...DEFAULT_JOB_CONFIG,
      taskInstruction: '提取用户画像',
      formatPlan: JSON.stringify({
        categories: [{ name: '行为模式' }],
        rules: { content: '保留依据' },
        output: { mode: 'json', topLevelKey: 'profiles', itemFields: ['pattern', 'evidence'] },
      }),
    });
    expect(prompt).toContain('任务专属 JSON');
    expect(prompt).toContain('顶层 key 为 profiles');
    expect(prompt).toContain('不要改回固定 knowledge 结构');
  });

  it('用户填写的目标贯穿所有阶段，默认模板不注入领域目标', () => {
    const taskInstruction = '提取可复用的用户画像与个人成长知识，依据长期或重复行为提出改进建议；区分事实与归纳判断，避免单次事件贴标签';
    const config = { ...DEFAULT_JOB_CONFIG, taskInstruction };
    const prompts = [
      buildIndexPrompt('marker', 'chunk-0', '多次沟通记录', config),
      buildDistillationPrompt('marker', '多次沟通记录', '{"units":[]}', config),
      buildFormatPlanPrompt('marker', ['{"knowledge":[]}'], config),
      buildNormalizePrompt('marker', '{"categories":[]}', ['{"knowledge":[]}'], config),
      buildReducePrompt('marker', ['{"knowledge":[]}'], config, true),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain(`目标：${taskInstruction}`);
      expect(prompt).not.toContain('公司内部知识助手');
      expect(prompt).not.toContain('固定的企业知识分类');
    }
    expect(prompts[0]).toContain('长期或重复模式保留多处可定位线索');
    expect(prompts[1]).toContain('区分直接事实、归纳判断和建议');
    expect(prompts[2]).toContain('区分事实、归纳判断和建议');
    expect(prompts[3]).toContain('保留事实、归纳判断、建议及其依据');
    expect(prompts[4]).toContain('建议需对应已证实的问题或模式');
  });

  it('允许按任务保存并渲染自定义阶段模板', () => {
    const prompt = buildExtractionPrompt('marker', '原文内容', {
      ...DEFAULT_JOB_CONFIG,
      taskInstruction: '提取待办',
      promptTemplates: {
        ...DEFAULT_PROMPT_TEMPLATES,
        extract: '自定义阶段\n目标={{task}}\n输入={{input}}\n标记={{marker}}',
      },
    });
    expect(prompt).toBe('自定义阶段\n目标=提取待办\n输入=原文内容\n标记=marker');
  });
});
