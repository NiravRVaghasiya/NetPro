// packages/core/src/skills/taxonomy.ts
//
// v2.0 Phase 5 — the embedded, bounded skill taxonomy.
//
// Every skill NetPro can attribute to a person comes from this list. That is a
// deliberate ceiling, not a limitation to grow out of: a bounded vocabulary is
// what makes the gap analysis explainable ("kubernetes: 0 contacts" means
// something because every contact was scanned for the same word list), keeps
// the AI extractor honest (the model may only *choose* from this list, never
// invent), and gives the search filter a stable value set. No network, no
// dependency, no model is needed to use it.
//
// Aliases are matched as whole tokens against lower-cased text (see
// extract.ts). Words that are ordinary English in a bio — "go", "excel",
// "spark", "growth" — are flagged `ambiguousName` so only their explicit,
// unambiguous aliases count: a false positive here would be *persisted onto a
// person*, which is worse than a miss the owner can fix by hand.

export const SKILL_CATEGORIES = [
  'languages',
  'frontend',
  'backend',
  'mobile',
  'cloud',
  'data',
  'ai',
  'security',
  'product',
  'design',
  'business',
  'leadership',
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export interface SkillDefinition {
  readonly name: string;
  readonly category: SkillCategory;
  /** Lower-case aliases matched as whole tokens; the name itself is matched too unless `ambiguousName`. */
  readonly aliases: readonly string[];
  /**
   * The bare name is an ordinary English word in bios ("I excel at…", "spark
   * joy", "go-to-market") — match only the explicit aliases, never the name.
   */
  readonly ambiguousName?: boolean;
}

export const SKILL_DEFINITIONS = [
  // ── languages ────────────────────────────────────────────────────────────
  { name: 'typescript', category: 'languages', aliases: ['ts'] },
  { name: 'javascript', category: 'languages', aliases: ['js', 'ecmascript'] },
  { name: 'python', category: 'languages', aliases: [] },
  { name: 'java', category: 'languages', aliases: [] },
  { name: 'go', category: 'languages', aliases: ['golang', 'go lang', 'go developer', 'go engineer', 'go programmer'], ambiguousName: true },
  { name: 'rust', category: 'languages', aliases: [] },
  { name: 'c++', category: 'languages', aliases: ['cpp'] },
  { name: 'c#', category: 'languages', aliases: ['csharp', '.net', 'asp.net', 'dotnet'] },
  { name: 'ruby', category: 'languages', aliases: ['ruby on rails', 'rails developer', 'rails engineer'] },
  { name: 'php', category: 'languages', aliases: ['laravel', 'symfony'] },
  { name: 'swift', category: 'languages', aliases: ['swiftui', 'swift developer', 'swift engineer', 'swift/ios', 'ios/swift'], ambiguousName: true },
  { name: 'kotlin', category: 'languages', aliases: [] },
  { name: 'scala', category: 'languages', aliases: [] },
  { name: 'sql', category: 'languages', aliases: [] },
  // ── frontend ─────────────────────────────────────────────────────────────
  { name: 'react', category: 'frontend', aliases: ['react.js', 'reactjs'] },
  { name: 'next.js', category: 'frontend', aliases: ['nextjs'] },
  { name: 'vue', category: 'frontend', aliases: ['vue.js', 'vuejs', 'nuxt'] },
  { name: 'angular', category: 'frontend', aliases: [] },
  { name: 'frontend', category: 'frontend', aliases: ['front-end', 'front end'] },
  { name: 'design systems', category: 'frontend', aliases: ['design system'] },
  // ── backend ──────────────────────────────────────────────────────────────
  { name: 'node.js', category: 'backend', aliases: ['nodejs', 'node js'] },
  { name: 'backend', category: 'backend', aliases: ['back-end', 'back end'] },
  { name: 'full stack', category: 'backend', aliases: ['full-stack', 'fullstack'] },
  { name: 'graphql', category: 'backend', aliases: [] },
  { name: 'rest apis', category: 'backend', aliases: ['rest api', 'restful', 'api design'] },
  { name: 'microservices', category: 'backend', aliases: ['micro-services'] },
  { name: 'distributed systems', category: 'backend', aliases: [] },
  { name: 'postgresql', category: 'backend', aliases: ['postgres'] },
  { name: 'mysql', category: 'backend', aliases: [] },
  { name: 'mongodb', category: 'backend', aliases: ['mongo'] },
  { name: 'redis', category: 'backend', aliases: [] },
  { name: 'kafka', category: 'backend', aliases: ['apache kafka'] },
  { name: 'elasticsearch', category: 'backend', aliases: ['opensearch'] },
  // ── mobile ───────────────────────────────────────────────────────────────
  { name: 'mobile', category: 'mobile', aliases: ['mobile development', 'mobile apps', 'mobile engineer'] },
  { name: 'ios', category: 'mobile', aliases: [] },
  { name: 'android', category: 'mobile', aliases: [] },
  { name: 'react native', category: 'mobile', aliases: ['react-native'] },
  { name: 'flutter', category: 'mobile', aliases: [] },
  // ── cloud / infrastructure ───────────────────────────────────────────────
  { name: 'aws', category: 'cloud', aliases: ['amazon web services'] },
  { name: 'azure', category: 'cloud', aliases: ['microsoft azure'] },
  { name: 'gcp', category: 'cloud', aliases: ['google cloud', 'google cloud platform'] },
  { name: 'cloud', category: 'cloud', aliases: ['cloud computing', 'cloud architecture', 'cloud infrastructure', 'cloud native'] },
  { name: 'docker', category: 'cloud', aliases: ['containerization'] },
  { name: 'kubernetes', category: 'cloud', aliases: ['k8s'] },
  { name: 'terraform', category: 'cloud', aliases: ['infrastructure as code', 'iac'] },
  { name: 'devops', category: 'cloud', aliases: ['dev ops', 'platform engineering'] },
  { name: 'ci/cd', category: 'cloud', aliases: ['ci cd', 'cicd', 'continuous integration', 'continuous delivery', 'continuous deployment'] },
  { name: 'sre', category: 'cloud', aliases: ['site reliability', 'site reliability engineering', 'observability'] },
  { name: 'linux', category: 'cloud', aliases: [] },
  // ── data ─────────────────────────────────────────────────────────────────
  { name: 'data engineering', category: 'data', aliases: ['data engineer', 'data pipelines', 'etl'] },
  { name: 'data science', category: 'data', aliases: ['data scientist'] },
  { name: 'analytics', category: 'data', aliases: ['data analytics', 'data analysis', 'data analyst', 'business intelligence'] },
  { name: 'spark', category: 'data', aliases: ['apache spark', 'pyspark', 'spark sql'], ambiguousName: true },
  { name: 'snowflake', category: 'data', aliases: [] },
  { name: 'dbt', category: 'data', aliases: [] },
  { name: 'airflow', category: 'data', aliases: ['apache airflow'] },
  { name: 'tableau', category: 'data', aliases: [] },
  { name: 'power bi', category: 'data', aliases: ['powerbi'] },
  { name: 'excel', category: 'data', aliases: ['microsoft excel', 'ms excel', 'advanced excel', 'excel modeling', 'excel modelling', 'spreadsheets'], ambiguousName: true },
  // ── ai ───────────────────────────────────────────────────────────────────
  { name: 'machine learning', category: 'ai', aliases: ['ml', 'ml engineer', 'machine-learning'] },
  { name: 'deep learning', category: 'ai', aliases: ['neural networks', 'pytorch', 'tensorflow'] },
  { name: 'nlp', category: 'ai', aliases: ['natural language processing'] },
  { name: 'llms', category: 'ai', aliases: ['llm', 'large language models', 'generative ai', 'genai', 'gen ai'] },
  { name: 'mlops', category: 'ai', aliases: ['ml ops'] },
  { name: 'computer vision', category: 'ai', aliases: [] },
  // ── security ─────────────────────────────────────────────────────────────
  { name: 'security', category: 'security', aliases: ['information security', 'infosec', 'appsec', 'application security', 'security engineer'] },
  { name: 'cybersecurity', category: 'security', aliases: ['cyber security', 'cyber'] },
  { name: 'compliance', category: 'security', aliases: ['soc 2', 'soc2', 'gdpr', 'iso 27001'] },
  { name: 'privacy', category: 'security', aliases: ['data privacy', 'data protection'] },
  // ── product ──────────────────────────────────────────────────────────────
  { name: 'product management', category: 'product', aliases: ['product manager', 'product lead', 'head of product', 'vp product', 'vp of product', 'cpo', 'chief product officer'] },
  { name: 'project management', category: 'product', aliases: ['project manager', 'pmp'] },
  { name: 'program management', category: 'product', aliases: ['program manager', 'tpm'] },
  { name: 'agile', category: 'product', aliases: ['scrum', 'kanban'] },
  { name: 'user research', category: 'product', aliases: ['ux research', 'usability'] },
  // ── design ───────────────────────────────────────────────────────────────
  { name: 'ux design', category: 'design', aliases: ['ux', 'user experience', 'ux designer'] },
  { name: 'ui design', category: 'design', aliases: ['ui', 'user interface', 'ui designer', 'visual design'] },
  { name: 'product design', category: 'design', aliases: ['product designer'] },
  { name: 'figma', category: 'design', aliases: [] },
  // ── business ─────────────────────────────────────────────────────────────
  { name: 'sales', category: 'business', aliases: ['account executive', 'sales development', 'sdr', 'enterprise sales', 'b2b sales', 'head of sales', 'vp sales', 'vp of sales'] },
  { name: 'business development', category: 'business', aliases: ['bizdev', 'biz dev'] },
  { name: 'partnerships', category: 'business', aliases: ['partner management', 'alliances'] },
  { name: 'marketing', category: 'business', aliases: ['cmo', 'brand marketing', 'brand manager', 'brand strategy', 'demand generation', 'demand gen'] },
  { name: 'growth', category: 'business', aliases: ['growth marketing', 'growth hacking', 'head of growth', 'growth lead', 'growth manager', 'vp growth', 'user acquisition'], ambiguousName: true },
  { name: 'seo', category: 'business', aliases: ['search engine optimization'] },
  { name: 'content marketing', category: 'business', aliases: ['content strategy', 'copywriting'] },
  { name: 'customer success', category: 'business', aliases: ['customer support', 'account management', 'account manager'] },
  { name: 'operations', category: 'business', aliases: ['coo', 'chief operating officer', 'head of operations', 'vp operations', 'vp of operations', 'director of operations', 'operations manager', 'operations lead', 'business operations', 'bizops', 'revops'], ambiguousName: true },
  { name: 'strategy', category: 'business', aliases: ['corporate strategy', 'business strategy', 'strategy consulting', 'head of strategy', 'chief strategy officer'], ambiguousName: true },
  { name: 'consulting', category: 'business', aliases: ['consultant', 'management consulting'] },
  { name: 'fundraising', category: 'business', aliases: ['series a', 'series b', 'seed round', 'raising capital', 'capital raise'] },
  { name: 'venture capital', category: 'business', aliases: ['vc', 'investor', 'angel investor', 'general partner'] },
  { name: 'finance', category: 'business', aliases: ['cfo', 'financial planning', 'fp&a', 'corporate finance'] },
  { name: 'accounting', category: 'business', aliases: ['cpa', 'accountant', 'financial controller'] },
  { name: 'legal', category: 'business', aliases: ['general counsel', 'legal counsel', 'corporate counsel', 'attorney', 'lawyer'] },
  { name: 'recruiting', category: 'business', aliases: ['talent acquisition', 'recruiter', 'talent sourcing'] },
  { name: 'people operations', category: 'business', aliases: ['people ops', 'human resources', 'hr', 'chief people officer'] },
  // ── leadership ───────────────────────────────────────────────────────────
  { name: 'engineering management', category: 'leadership', aliases: ['engineering manager', 'head of engineering', 'vp engineering', 'vp of engineering', 'director of engineering', 'cto', 'chief technology officer'] },
  { name: 'founder', category: 'leadership', aliases: ['co-founder', 'cofounder', 'entrepreneur'] },
  { name: 'executive leadership', category: 'leadership', aliases: ['ceo', 'chief executive officer', 'chief executive', 'managing director', 'c-suite'] },
  { name: 'mentoring', category: 'leadership', aliases: ['mentor', 'coaching', 'coach'] },
  { name: 'public speaking', category: 'leadership', aliases: ['public speaker', 'keynote', 'keynote speaker', 'conference speaker', 'tedx'] },
] as const satisfies readonly SkillDefinition[];

export type Skill = (typeof SKILL_DEFINITIONS)[number]['name'];

/** Canonical skill names, in taxonomy order. */
export const SKILL_TAXONOMY: readonly Skill[] = SKILL_DEFINITIONS.map((d) => d.name);

/**
 * Normalise text for matching: lower-case, separators (slashes, hyphens,
 * brackets, quotes, commas…) become spaces, and `+ # . &` survive inside a
 * token so `c++`, `c#`, `node.js`, `.net` and `fp&a` stay whole. Aliases are
 * normalised with the SAME function, which is why `co-founder`/`cofounder`
 * and `ci/cd`/`ci cd` need no extra spelling in the table.
 */
export function normalizeMatchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s/\\,;:()[\]{}|!?"'“”‘’`<>=*~@$%^_\-–—]+/g, ' ')
    .split(' ')
    .map((token) => token.replace(/\.+$/, ''))
    .filter((token) => token.length > 0)
    .join(' ');
}

const BY_NAME = new Map<string, SkillDefinition>(SKILL_DEFINITIONS.map((d) => [d.name, d]));

/** Every name + alias → skill. Used for explicit input (tags, `--skills`, the AI's picks). */
const EXPLICIT = new Map<string, Skill>();
/** Same, minus the bare names flagged `ambiguousName`. Used when scanning prose. */
const SCAN = new Map<string, Skill>();
/**
 * First word of every alias → the longest alias (in words) that starts with
 * it. The prose scanner consults this before building any n-gram, so the
 * common case — a token that begins no alias at all — costs one Map lookup.
 */
const FIRST_WORD_SPAN = new Map<string, number>();
let maxAliasWords = 1;
for (const def of SKILL_DEFINITIONS as readonly SkillDefinition[]) {
  const keys = [def.name, ...def.aliases].map(normalizeMatchText);
  for (const key of keys) {
    EXPLICIT.set(key, def.name as Skill);
    const words = key.split(' ');
    maxAliasWords = Math.max(maxAliasWords, words.length);
    FIRST_WORD_SPAN.set(words[0]!, Math.max(FIRST_WORD_SPAN.get(words[0]!) ?? 0, words.length));
  }
  for (const key of keys.slice(def.ambiguousName ? 1 : 0)) SCAN.set(key, def.name as Skill);
}

/** Longest alias, in words — the n-gram window the scanner has to consider. */
export const MAX_ALIAS_WORDS = maxAliasWords;

export function isSkill(value: unknown): value is Skill {
  return typeof value === 'string' && BY_NAME.has(value);
}

export function skillDefinition(skill: Skill): SkillDefinition {
  return BY_NAME.get(skill)!;
}

export function skillCategory(skill: Skill): SkillCategory {
  return BY_NAME.get(skill)!.category;
}

/**
 * Map free input ("K8s", " TypeScript ", "ml") to its canonical skill, or
 * null when it is not in the taxonomy. Exact name/alias matches only —
 * whole-text scanning belongs to extraction, where evidence is recorded.
 */
export function canonicalSkill(input: unknown): Skill | null {
  if (typeof input !== 'string') return null;
  const key = normalizeMatchText(input);
  return key ? (EXPLICIT.get(key) ?? null) : null;
}

/** Look up one normalised n-gram. `permissive` admits the ambiguous bare names. */
/** Longest alias (in words) beginning with `token`, or 0 when no alias starts with it. */
export function aliasSpanFrom(token: string): number {
  return FIRST_WORD_SPAN.get(token) ?? 0;
}

export function lookupAlias(gram: string, permissive: boolean): Skill | undefined {
  return (permissive ? EXPLICIT : SCAN).get(gram);
}

/** Test-only introspection: the normalised alias table (explicit variant). */
export function aliasTable(): ReadonlyMap<string, Skill> {
  return EXPLICIT;
}

/**
 * Partial-coverage rules for the gap analysis: a required skill counts as
 * *partially* covered when the candidate has every skill in `all`, or any
 * skill in `any`. Kept small and legible on purpose — a rule here must be one
 * a reader would nod at, not a learned similarity.
 */
export const PARTIAL_COVERAGE: Readonly<Partial<Record<Skill, { all?: readonly Skill[]; any?: readonly Skill[] }>>> = {
  'full stack': { all: ['frontend', 'backend'] },
  frontend: { any: ['full stack', 'react', 'vue', 'angular', 'next.js'] },
  backend: { any: ['full stack', 'node.js', 'microservices', 'distributed systems'] },
  javascript: { any: ['typescript'] },
  typescript: { any: ['javascript'] },
  sql: { any: ['postgresql', 'mysql', 'snowflake', 'dbt', 'spark'] },
  react: { any: ['next.js', 'react native'] },
  'next.js': { any: ['react'] },
  cybersecurity: { any: ['security'] },
  security: { any: ['cybersecurity', 'compliance'] },
  cloud: { any: ['aws', 'azure', 'gcp'] },
  aws: { any: ['cloud'] },
  azure: { any: ['cloud'] },
  gcp: { any: ['cloud'] },
  devops: { any: ['ci/cd', 'kubernetes', 'terraform', 'sre'] },
  kubernetes: { any: ['docker', 'devops'] },
  'data science': { any: ['machine learning', 'analytics'] },
  'machine learning': { any: ['data science', 'deep learning', 'mlops'] },
  'deep learning': { any: ['machine learning'] },
  llms: { any: ['nlp', 'machine learning'] },
  'ux design': { any: ['product design', 'user research'] },
  'ui design': { any: ['product design', 'design systems'] },
  'product design': { any: ['ux design', 'ui design'] },
  'product management': { any: ['program management'] },
  'engineering management': { any: ['founder', 'executive leadership'] },
  sales: { any: ['business development'] },
  'business development': { any: ['sales', 'partnerships'] },
  marketing: { any: ['growth', 'content marketing', 'seo'] },
  finance: { any: ['accounting', 'fundraising'] },
};
