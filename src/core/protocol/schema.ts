/**
 * 知识提炼协议（统一 knowledge 条目结构）。
 * 该契约属于核心层资产：所有 Provider 的输出都必须被清洗成同一结构，
 * Adapter 只搬运文本，不自定义结果格式。
 */
export const EXTRACTION_SCHEMA_VERSION = 3;

export interface PersonItem {
  name: string;
  role?: string;
  department?: string;
  responsibilities?: string[];
}

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
  people?: string[];
}

export interface ExtractionResult {
  version: number;
  knowledge: KnowledgeItem[];
  people?: PersonItem[];
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

export interface FormatCategory {
  name: string;
  meaning?: string;
  aliases?: string[];
}

export interface FormatPlan {
  version: 1;
  categories: FormatCategory[];
  rules: {
    time?: string;
    topic?: string;
    content?: string;
    details?: string;
    merge?: string;
  };
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

export function parseFormatPlan(raw: string): FormatPlan | null {
  const parsed = parseJsonResult(raw);
  if (!parsed || Array.isArray(parsed)) return null;
  const categoriesValue = parsed['categories'];
  if (!Array.isArray(categoriesValue) || categoriesValue.length === 0) return null;
  const categories: FormatCategory[] = [];
  for (const value of categoriesValue) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    const name = asString(item['name']);
    if (!name) return null;
    const meaning = asString(item['meaning']);
    const aliasesValue = item['aliases'];
    if (aliasesValue !== undefined && (!Array.isArray(aliasesValue) || aliasesValue.some((alias) => typeof alias !== 'string'))) return null;
    const aliases = Array.isArray(aliasesValue) ? aliasesValue.map((alias) => alias.trim()).filter(Boolean) : undefined;
    categories.push({ name, ...(meaning ? { meaning } : {}), ...(aliases && aliases.length > 0 ? { aliases } : {}) });
  }
  const rulesValue = parsed['rules'];
  if (typeof rulesValue !== 'object' || rulesValue === null || Array.isArray(rulesValue)) return null;
  const rulesSource = rulesValue as Record<string, unknown>;
  const ruleKeys = ['time', 'topic', 'content', 'details', 'merge'] as const;
  const rules: FormatPlan['rules'] = {};
  for (const key of ruleKeys) {
    const value = asString(rulesSource[key]);
    if (value) rules[key] = value;
  }
  if (Object.keys(rules).length === 0) return null;
  return { version: 1, categories, rules };
}

export function isExtractionResult(value: unknown): value is ExtractionResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return rec.version === EXTRACTION_SCHEMA_VERSION
    && Array.isArray(rec.knowledge)
    && (rec.people === undefined || Array.isArray(rec.people));
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

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.some((item) => typeof item !== 'string')) return null;
  return v.map((item) => item.trim()).filter(Boolean);
}

function sanitizePeople(value: unknown): PersonItem[] | null {
  if (!Array.isArray(value)) return null;
  const people: PersonItem[] = [];
  const allowedKeys = new Set(['name', 'role', 'department', 'responsibilities']);
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const src = item as Record<string, unknown>;
    if (Object.keys(src).some((key) => !allowedKeys.has(key))) return null;
    const name = asString(src['name']);
    if (!name) return null;
    const person: PersonItem = { name };
    const role = asString(src['role']);
    const department = asString(src['department']);
    if (role) person.role = role;
    if (department) person.department = department;
    if (src['responsibilities'] !== undefined) {
      const responsibilities = asStringArray(src['responsibilities']);
      if (!responsibilities) return null;
      if (responsibilities.length > 0) person.responsibilities = responsibilities;
    }
    people.push(person);
  }
  return people;
}

function sanitizeKnowledgeItems(value: unknown): KnowledgeItem[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: KnowledgeItem[] = [];
  // review 是旧版协议字段：兼容读取但不再写入，审核由外部系统负责。
  const allowedKeys = new Set(['time', 'category', 'topic', 'content', 'details', 'people', 'review']);
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
    if (src['people'] !== undefined) {
      const people = asStringArray(src['people']);
      if (!people) return null;
      if (people.length > 0) entry.people = people;
    }
    normalized.push(entry);
  }
  return normalized;
}

const credentialPattern = /(password|passcode|cookie|session|token|验证码|密码|登录凭证|账号登录|邮箱登录|邀请码|账号.{0,6}登录|登录.{0,8}(?:邮箱|账号|密码|验证码|邀请码)|(?:邮箱|账号).{0,8}(?:密码|验证码))/i;
const phonePattern = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)|(?<!\d)\d{3,4}[-\s]\d{7,8}(?!\d)/g;

function sanitizeText(value: string): string {
  const redacted = value.replace(phonePattern, '[敏感信息已脱敏]');
  // 只移除包含凭证/登录操作的句子，尽量保留同一条中的非敏感业务规则。
  return redacted
    .split(/(?<=[。！？!?；;\n])/)
    .filter((part) => !credentialPattern.test(part))
    .join('')
    .trim();
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) {
    return value.map(sanitizeValue).filter((item) => !(typeof item === 'string' && item.length === 0));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !credentialPattern.test(key))
      .map(([key, item]) => [key, sanitizeValue(item)])
      .filter(([, item]) => !(typeof item === 'string' && item.length === 0)));
  }
  return value;
}

function sanitizeKnowledgeItem(item: KnowledgeItem): KnowledgeItem | null {
  if (credentialPattern.test(item.category) || credentialPattern.test(item.topic)) return null;
  const content = sanitizeText(item.content);
  if (!content) return null;
  const sanitized: KnowledgeItem = {
    category: sanitizeText(item.category),
    topic: sanitizeText(item.topic),
    content,
  };
  if (!sanitized.category || !sanitized.topic) return null;
  if (item.time) sanitized.time = sanitizeText(item.time);
  if (item.details) sanitized.details = sanitizeValue(item.details) as Record<string, unknown>;
  if (item.people) {
    const people = item.people
      .filter((person) => !credentialPattern.test(person))
      .map(sanitizeText)
      .filter(Boolean);
    if (people.length > 0) sanitized.people = people;
  }
  return sanitized;
}

/** 只拦截凭证/登录细节；普通业务知识不做泛化清洗。 */
function filterSensitiveKnowledge(result: ExtractionResult): ExtractionResult {
  const knowledge = result.knowledge
    .map(sanitizeKnowledgeItem)
    .filter((item): item is KnowledgeItem => item !== null);
  const people = result.people
    ?.map((person) => ({
      ...person,
      name: sanitizeText(person.name),
      role: person.role ? sanitizeText(person.role) : undefined,
      department: person.department ? sanitizeText(person.department) : undefined,
      responsibilities: person.responsibilities?.map(sanitizeText).filter(Boolean),
    }))
    .filter((person) => person.name && !credentialPattern.test(person.name))
    .map((person) => ({
      ...person,
      responsibilities: person.responsibilities?.filter(Boolean),
    }))
    .map((person) => {
      if (person.responsibilities && person.responsibilities.length === 0) {
        const { responsibilities: _removed, ...withoutResponsibilities } = person;
        return withoutResponsibilities;
      }
      return person;
    });
  return {
    version: EXTRACTION_SCHEMA_VERSION,
    knowledge,
    ...(people && people.length > 0 ? { people } : {}),
  };
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
  if (Object.keys(rec).some((key) => key !== 'version' && key !== 'knowledge' && key !== 'people')) return null;
  const people = rec['people'] === undefined ? null : sanitizePeople(rec['people']);
  if (rec['people'] !== undefined && !people) return null;
  return filterSensitiveKnowledge({
    version: EXTRACTION_SCHEMA_VERSION,
    knowledge,
    ...(people && people.length > 0 ? { people } : {}),
  });
}
