/**
 * 知识提炼协议（schema v1）。
 * 该契约属于核心层资产：所有 Provider 的输出都必须被清洗成同一结构，
 * Adapter 只搬运文本，不自定义结果格式。
 */
export const EXTRACTION_SCHEMA_VERSION = 1;

export interface FactItem { text: string; time?: string; confidence?: 'high' | 'medium' | 'low' }
export interface ProjectItem { name: string; description?: string; status?: string }
export interface DecisionItem { what: string; why?: string; when?: string }
export interface SolutionItem { problem: string; solution: string }
export interface PreferenceItem { topic: string; preference: string }
export interface TimelineItem { time: string; event: string }
export interface TodoItem { task: string; owner?: string; due?: string }
export interface OpenQuestionItem { question: string; context?: string }

export interface ExtractionResult {
  version: number;
  facts: FactItem[];
  projects: ProjectItem[];
  decisions: DecisionItem[];
  solutions: SolutionItem[];
  preferences: PreferenceItem[];
  timeline: TimelineItem[];
  todos: TodoItem[];
  openQuestions: OpenQuestionItem[];
}

const SECTION_KEYS = [
  'facts', 'projects', 'decisions', 'solutions', 'preferences', 'timeline', 'todos', 'openQuestions',
] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

const REQUIRED_FIELDS: Record<SectionKey, readonly string[]> = {
  facts: ['text'],
  projects: ['name'],
  decisions: ['what'],
  solutions: ['problem', 'solution'],
  preferences: ['topic', 'preference'],
  timeline: ['time', 'event'],
  todos: ['task'],
  openQuestions: ['question'],
};

const OPTIONAL_FIELDS: Record<SectionKey, readonly string[]> = {
  facts: ['time', 'confidence'],
  projects: ['description', 'status'],
  decisions: ['why', 'when'],
  solutions: [],
  preferences: [],
  timeline: [],
  todos: ['owner', 'due'],
  openQuestions: ['context'],
};

export function emptyExtraction(): ExtractionResult {
  return {
    version: EXTRACTION_SCHEMA_VERSION,
    facts: [], projects: [], decisions: [], solutions: [],
    preferences: [], timeline: [], todos: [], openQuestions: [],
  };
}

export function mergeExtractions(list: ExtractionResult[]): ExtractionResult {
  const out = emptyExtraction();
  for (const r of list) {
    for (const key of SECTION_KEYS) (out[key] as unknown[]).push(...(r[key] as unknown[]));
  }
  return out;
}

/** 从模型回复中提取 JSON：优先 ```json 代码块，否则做带字符串感知的平衡括号扫描 */
export function extractJsonBlock(raw: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence && fence[1] && fence[1].trim().startsWith('{')) return fence[1].trim();
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
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
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v.trim().length > 0 ? v : null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/**
 * 把模型输出清洗成 schema v1：字段缺失补空数组、条目缺必填字段丢弃、
 * 非字符串标量强制转字符串、非法 confidence 剔除。解析失败返回 null。
 */
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
  const out = emptyExtraction();
  for (const key of SECTION_KEYS) {
    const arr = rec[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item !== 'object' || item === null) continue;
      const src = item as Record<string, unknown>;
      const coerced: Record<string, string> = {};
      let ok = true;
      for (const f of REQUIRED_FIELDS[key]) {
        const s = asString(src[f]);
        if (s === null) { ok = false; break; }
        coerced[f] = s;
      }
      if (!ok) continue;
      for (const f of OPTIONAL_FIELDS[key]) {
        const s = asString(src[f]);
        if (s !== null) coerced[f] = s;
      }
      if (key === 'facts' && coerced['confidence'] && !['high', 'medium', 'low'].includes(coerced['confidence'])) {
        delete coerced['confidence'];
      }
      (out[key] as unknown[]).push(coerced);
    }
  }
  return out;
}