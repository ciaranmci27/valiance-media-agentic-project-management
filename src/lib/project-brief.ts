/**
 * A project's brief: its context entries (pm.project_context) read as
 * sections, plus its goals (pm.project_goals stays their source). Shapes and
 * pure helpers the server and the screens share.
 *
 * - Every entry has a section. Entries written with only a category (the
 *   fleet's add_project_context, older code) get the section their category
 *   maps to; the database sets it, so both read the same.
 * - category stays one of the five it always was, so every reader of
 *   get_project_context keeps working. An entry written by section gets the
 *   category its section maps to.
 * - pinned entries go into every agent's context for the project (its
 *   context pack and get_task_brief); the rest are found by search.
 * - Freshness is updated_at: nothing marks an entry stale on its own.
 */

export const PROJECT_CONTEXT_CATEGORIES = ['business_context', 'existing_work', 'technical_decision', 'constraint', 'lesson_learned'] as const;
export type ProjectContextCategory = (typeof PROJECT_CONTEXT_CATEGORIES)[number];

export const BRIEF_SECTION_KEYS = ['overview', 'rules', 'decisions', 'links', 'glossary', 'history'] as const;
export type BriefSectionKey = (typeof BRIEF_SECTION_KEYS)[number];

/** The brief's entry sections, in the order a brief reads. Goals come from project goals and read after Overview. */
export const BRIEF_SECTIONS: { key: BriefSectionKey; label: string; hint: string }[] = [
  { key: 'overview', label: 'Overview', hint: 'What this project is, who it is for, what good looks like.' },
  { key: 'rules', label: 'Rules and constraints', hint: 'What must always or never happen.' },
  { key: 'decisions', label: 'Decisions and who decides', hint: 'Calls already made, and who makes the next ones.' },
  { key: 'links', label: 'Links', hint: 'Repos, docs, dashboards, designs.' },
  { key: 'glossary', label: 'Glossary', hint: 'Words this project uses in its own way.' },
  { key: 'history', label: 'History and lessons', hint: 'What was tried, what worked, what to avoid.' },
];

/** The section an entry of each category reads in (the database applies the same map). */
export const CATEGORY_SECTION: Record<ProjectContextCategory, BriefSectionKey> = {
  business_context: 'overview',
  constraint: 'rules',
  technical_decision: 'decisions',
  existing_work: 'history',
  lesson_learned: 'history',
};

/** The category an entry written by section is stored with, so readers by category still find it. */
export const SECTION_CATEGORY: Record<BriefSectionKey, ProjectContextCategory> = {
  overview: 'business_context',
  rules: 'constraint',
  decisions: 'technical_decision',
  links: 'business_context',
  glossary: 'business_context',
  history: 'lesson_learned',
};

export function isBriefSection(value: unknown): value is BriefSectionKey {
  return typeof value === 'string' && (BRIEF_SECTION_KEYS as readonly string[]).includes(value);
}

export function sectionOfCategory(category: string): BriefSectionKey {
  return CATEGORY_SECTION[category as ProjectContextCategory] ?? 'overview';
}

export function briefSectionLabel(key: string): string {
  return BRIEF_SECTIONS.find((section) => section.key === key)?.label ?? key;
}

/** Characters in one entry, as add_project_context has always taken. */
export const BRIEF_ENTRY_MAX = 20_000;
/** Entries one section shows in a brief read; the rest are paged with ?section= or found by search. */
export const BRIEF_SECTION_PAGE = 50;
/** Results one search answers at most. */
export const BRIEF_SEARCH_MAX = 50;

export interface BriefEntry {
  id: string;
  section: BriefSectionKey;
  category: ProjectContextCategory;
  content: string;
  pinned: boolean;
  source: 'human' | 'agent' | 'scan' | string;
  file_path: string | null;
  created_at: string;
  updated_at: string;
  /** Search results only: how well it matched, higher first. */
  rank?: number;
}

export interface BriefSection {
  key: BriefSectionKey;
  label: string;
  entries: BriefEntry[];
  /** Every active entry in the section; entries holds the first page. */
  total: number;
}

export interface BriefGoal {
  id: string;
  title: string;
  description: string | null;
  target_date: string | null;
  status: string;
}

export interface ProjectBrief {
  sections: BriefSection[];
  goals: BriefGoal[];
  /** Parts the viewer may not read (goals need goals.read and AI agents). */
  omitted: string[];
}
