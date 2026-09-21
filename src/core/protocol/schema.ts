/**
 * 知识提炼协议（统一 knowledge 条目结构）。
 * 该契约属于核心层资产：所有 Provider 的输出都必须被清洗成同一结构，
 * Adapter 只搬运文本，不自定义结果格式。
 */
export const EXTRACTION_SCHEMA_VERSION = 2;

/**
 * 面向持续维护的统一知识条目。
 * time 只在原文明确给出时填写；details 仅承载必要的参数、条件、步骤等补充信息。
 */
export interface KnowledgeItem {
  time?: string;
  category: string;
  topic: string;
  content: string;
  details?: Record<string, unknown>;
}

export interface ExtractionResult {
  version: number;
  knowledge: KnowledgeItem[];
}

/** 自定义任务可保留模型自定义 JSON；知识任务使用统一 knowledge 数组。 */
export type JsonResult = Record<string, unknown> | unknown[];

export interface IndexUnit {
  id: string;
  topic: string;
  sourceHints: string[];
  timeRange?: string;
}

export interface IndexResult {
  units: IndexUnit[];
}

/** 从模型回复中提取 JSON：优先 ```json 代码块，否则做带字符串感知的平衡括号扫描 */
export function extractJsonBlock(raw: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence && fence[1] && /^[\[{]/.test(fence[1].trim())) return fence[1].trim();
  const start = raw.search(/[\[{]/);
  if (start < 0) return null;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const opener = stack.at(-1);
      if ((ch === '}' && opener !== '{') || (ch === ']' && opener !== '[')) return null;
      stack.pop();
      if (stack.length === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** 解析并原样保留模型 JSON；仅拒绝无 JSON、语法错误和顶层标量。 */
export function parseJsonResult(raw: string): JsonResult | null {
  const block = extractJsonBlock(raw);
  if (!block) return null;
  try {
    const value: unknown = JSON.parse(block);
    if (typeof value !== 'object' || value === null) return null;
    return value as JsonResult;
  } catch {
    return null;
  }
}

/** 索引阶段契约比最终结果严格：下一阶段必须能据此回到原文定位。 */
export function parseIndexResult(raw: string): IndexResult | null {
  const parsed = parseJsonResult(raw);
  if (!parsed || Array.isArray(parsed)) return null;
  const units = parsed['units'];
  if (!Array.isArray(units)) return null;
  const normalized: IndexUnit[] = [];
  for (const value of units) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (typeof item['id'] !== 'string' || !item['id'].trim()) return null;
    if (typeof item['topic'] !== 'string' || !item['topic'].trim()) return null;
    if (!Array.isArray(item['sourceHints']) || item['sourceHints'].some((hint) => typeof hint !== 'string')) return null;
    const timeRange = typeof item['timeRange'] === 'string' && item['timeRange'].trim()
      ? item['timeRange'].trim()
      : undefined;
    const sourceHints = item['sourceHints'].map((hint) => (hint as string).trim()).filter(Boolean);
    if (sourceHints.length === 0) return null;
    normalized.push({
      id: item['id'].trim(),
      topic: item['topic'].trim(),
      sourceHints,
      ...(timeRange ? { timeRange } : {}),
    });
  }
  return { units: normalized };
}

export function isExtractionResult(value: unknown): value is ExtractionResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return rec.version === EXTRACTION_SCHEMA_VERSION
    && Array.isArray(rec.knowledge);
}

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v.trim().length > 0 ? v : null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function asDetails(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function sanitizeKnowledgeItems(value: unknown): KnowledgeItem[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: KnowledgeItem[] = [];
  const allowedKeys = new Set(['time', 'category', 'topic', 'content', 'details']);
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const src = item as Record<string, unknown>;
    if (Object.keys(src).some((key) => !allowedKeys.has(key))) return null;
    const category = asString(src['category']);
    const topic = asString(src['topic']);
    const content = asString(src['content']);
    if (!category || !topic || !content) return null;
    const entry: KnowledgeItem = { category, topic, content };
    const time = asString(src['time']);
    if (time) entry.time = time;
    if (src['details'] !== undefined) {
      const details = asDetails(src['details']);
      if (!details) return null;
      entry.details = details;
    }
    normalized.push(entry);
  }
  return normalized;
}

/** 把模型输出校验并规范成统一 knowledge 契约；解析失败返回 null。 */
export function sanitizeExtraction(raw: string): ExtractionResult | null {
  const block = extractJsonBlock(raw);
  if (!block) return null;
  let data: unknown;
  try {
    data = JSON.parse(block);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const rec = data as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(rec, 'knowledge')) return null;
  const knowledge = sanitizeKnowledgeItems(rec['knowledge']);
  if (!knowledge) return null;
  if (Object.keys(rec).some((key) => key !== 'version' && key !== 'knowledge')) return null;
  return { version: EXTRACTION_SCHEMA_VERSION, knowledge };
}
