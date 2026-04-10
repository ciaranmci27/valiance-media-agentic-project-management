'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Pencil, Trash2, X, Check, ChevronDown, ChevronRight,
  Briefcase, Layers, GitBranch, AlertTriangle, Lightbulb,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  ProjectContext,
  ProjectContextCategory,
  PROJECT_CONTEXT_CATEGORIES,
} from '@/lib/types';

interface ProjectContextPanelProps {
  projectId: string;
}

const CATEGORY_CONFIG: Record<ProjectContextCategory, {
  label: string;
  description: string;
  icon: typeof Briefcase;
  bg: string;
  text: string;
  iconColor: string;
}> = {
  business_context: {
    label: 'Business Context',
    description: 'Goals, audience, value proposition',
    icon: Briefcase,
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    iconColor: 'text-blue-500',
  },
  existing_work: {
    label: 'What Exists',
    description: 'Current state, completed work',
    icon: Layers,
    bg: 'bg-emerald-50',
    text: 'text-emerald-700',
    iconColor: 'text-emerald-500',
  },
  technical_decision: {
    label: 'Technical Decisions',
    description: 'Architecture, tools, patterns chosen',
    icon: GitBranch,
    bg: 'bg-violet-50',
    text: 'text-violet-700',
    iconColor: 'text-violet-500',
  },
  constraint: {
    label: 'Constraints',
    description: 'Limits, requirements, non-negotiables',
    icon: AlertTriangle,
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    iconColor: 'text-amber-500',
  },
  lesson_learned: {
    label: 'Lessons Learned',
    description: 'Past mistakes, insights, best practices',
    icon: Lightbulb,
    bg: 'bg-rose-50',
    text: 'text-rose-700',
    iconColor: 'text-rose-500',
  },
};

const SOURCE_COLORS: Record<string, string> = {
  human: 'bg-blue-50 text-blue-700',
  agent: 'bg-purple-50 text-purple-700',
  scan: 'bg-zinc-100 text-zinc-600',
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function ProjectContextPanel({ projectId }: ProjectContextPanelProps) {
  const [entries, setEntries] = useState<ProjectContext[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  // Add form state
  const [addingCategory, setAddingCategory] = useState<ProjectContextCategory | null>(null);
  const [addContent, setAddContent] = useState('');

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const supabase = createClient();

  const fetchEntries = useCallback(async () => {
    const { data, error } = await supabase
      .from('project_context')
      .select('*')
      .eq('project_id', projectId)
      .eq('is_active', true)
      .order('category')
      .order('created_at');

    if (error) {
      console.error('Failed to fetch project context:', error);
      toast('error', 'Failed to load project context');
      setLoading(false);
      return;
    }
    setEntries(data || []);
    setLoading(false);
  }, [projectId]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const handleAdd = async () => {
    if (!addingCategory || !addContent.trim()) return;

    const { data, error } = await supabase
      .from('project_context')
      .insert({
        project_id: projectId,
        category: addingCategory,
        content: addContent.trim(),
        source: 'human',
      })
      .select()
      .single();

    if (error) {
      toast('error', 'Failed to add entry');
      return;
    }

    setEntries(prev => [...prev, data]);
    setAddingCategory(null);
    setAddContent('');
    // Auto-expand the category we just added to
    setExpandedCategories(prev => new Set(prev).add(addingCategory));
    toast('success', 'Context entry added');
  };

  const handleEdit = async (id: string) => {
    if (!editContent.trim()) return;

    const { data, error } = await supabase
      .from('project_context')
      .update({ content: editContent.trim() })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      toast('error', 'Failed to update entry');
      return;
    }

    setEntries(prev => prev.map(e => e.id === id ? data : e));
    setEditingId(null);
    toast('success', 'Entry updated');
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;

    const { error } = await supabase
      .from('project_context')
      .update({ is_active: false })
      .eq('id', deleteTarget);

    if (error) {
      toast('error', 'Failed to remove entry');
      return;
    }

    setEntries(prev => prev.filter(e => e.id !== deleteTarget));
    setDeleteTarget(null);
    toast('success', 'Entry removed');
  };

  const startEdit = (entry: ProjectContext) => {
    setEditingId(entry.id);
    setEditContent(entry.content);
  };

  const toggleCategory = (cat: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const startAdding = (cat: ProjectContextCategory) => {
    setAddingCategory(cat);
    setAddContent('');
    setExpandedCategories(prev => new Set(prev).add(cat));
  };

  const grouped = PROJECT_CONTEXT_CATEGORIES.reduce((acc, cat) => {
    acc[cat] = entries.filter(e => e.category === cat);
    return acc;
  }, {} as Record<ProjectContextCategory, ProjectContext[]>);

  if (loading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-xl border border-zinc-200 p-4 animate-pulse">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-lg bg-zinc-100" />
              <div className="flex-1">
                <div className="h-4 w-24 bg-zinc-100 rounded" />
                <div className="h-3 w-40 bg-zinc-50 rounded mt-1" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {PROJECT_CONTEXT_CATEGORIES.map(cat => {
          const config = CATEGORY_CONFIG[cat];
          const catEntries = grouped[cat];
          const isExpanded = expandedCategories.has(cat);
          const CategoryIcon = config.icon;

          return (
            <div
              key={cat}
              className="rounded-xl border border-zinc-200 bg-white hover:border-zinc-300 transition-all overflow-hidden flex flex-col max-h-[400px]"
            >
              {/* Category header */}
              <div className="px-4 py-3 flex items-center gap-3 flex-shrink-0">
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${config.bg}`}>
                  <CategoryIcon size={16} className={config.iconColor} />
                </div>

                <button
                  onClick={() => toggleCategory(cat)}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-semibold text-zinc-900">{config.label}</p>
                    {catEntries.length > 0 && (
                      <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded ${config.bg} ${config.text}`}>
                        {catEntries.length}
                      </span>
                    )}
                    {isExpanded
                      ? <ChevronDown size={14} className="text-zinc-400" />
                      : <ChevronRight size={14} className="text-zinc-400" />
                    }
                  </div>
                  <p className="text-[11px] text-zinc-400 mt-0.5">{config.description}</p>
                </button>

                <Tooltip content="Add entry">
                  <button
                    onClick={() => startAdding(cat)}
                    className="p-1.5 text-zinc-400 hover:text-brand-600 transition-colors rounded-md hover:bg-zinc-50 flex-shrink-0"
                  >
                    <Plus size={14} />
                  </button>
                </Tooltip>
              </div>

              {/* Expanded content */}
              {isExpanded && (
                <div className="px-4 pb-4 space-y-2 overflow-y-auto overflow-x-hidden">
                  {/* Add form */}
                  {addingCategory === cat && (
                    <div className="border border-brand-200 bg-brand-50/30 rounded-lg p-3 space-y-2">
                      <Textarea
                        value={addContent}
                        onChange={setAddContent}
                        placeholder={`Add ${config.label.toLowerCase()} entry...`}
                        rows={2}
                        size="sm"
                        autoFocus
                      />
                      <div className="flex items-center gap-2 justify-end">
                        <button
                          onClick={() => setAddingCategory(null)}
                          className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-700 transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleAdd}
                          disabled={!addContent.trim()}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50 transition-all"
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Entries */}
                  {catEntries.length === 0 && addingCategory !== cat && (
                    <p className="text-xs text-zinc-400 py-2">No entries yet</p>
                  )}

                  {catEntries.map(entry => (
                    <div key={entry.id} className="group">
                      {editingId === entry.id ? (
                        <div className="border border-brand-200 bg-brand-50/30 rounded-lg p-3 space-y-2">
                          <Textarea
                            value={editContent}
                            onChange={setEditContent}
                            rows={2}
                            size="sm"
                            autoFocus
                          />
                          <div className="flex justify-end gap-1">
                            <button onClick={() => setEditingId(null)} className="p-1.5 text-zinc-400 hover:text-zinc-600 transition-colors">
                              <X size={14} />
                            </button>
                            <button onClick={() => handleEdit(entry.id)} className="p-1.5 text-emerald-600 hover:text-emerald-700 transition-colors">
                              <Check size={14} />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start gap-2 p-2.5 rounded-lg hover:bg-zinc-50 transition-colors">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-zinc-800 leading-relaxed break-words">{entry.content}</p>
                            <div className="flex items-center gap-2 mt-1.5">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${SOURCE_COLORS[entry.source]}`}>
                                {entry.source}
                              </span>
                              <span className="text-[10px] text-zinc-400">{timeAgo(entry.updated_at)}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                            <Tooltip content="Edit">
                              <button onClick={() => startEdit(entry)} className="p-1.5 text-zinc-400 hover:text-brand-600 transition-colors rounded-md">
                                <Pencil size={12} />
                              </button>
                            </Tooltip>
                            <Tooltip content="Remove">
                              <button onClick={() => setDeleteTarget(entry.id)} className="p-1.5 text-zinc-400 hover:text-red-500 transition-colors rounded-md">
                                <Trash2 size={12} />
                              </button>
                            </Tooltip>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Remove Entry"
        message="This entry will be deactivated. Are you sure?"
        confirmLabel="Remove"
        variant="danger"
      />
    </>
  );
}
