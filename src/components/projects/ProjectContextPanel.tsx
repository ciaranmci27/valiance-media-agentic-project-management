'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, X, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Textarea } from '@/components/ui/inputs/Textarea';
import {
  ProjectContext,
  ProjectContextCategory,
  PROJECT_CONTEXT_CATEGORIES,
} from '@/lib/types';

interface ProjectContextPanelProps {
  projectId: string;
}

const CATEGORY_LABELS: Record<ProjectContextCategory, string> = {
  business_context: 'Business Context',
  existing_work: 'What Exists',
  technical_decision: 'Technical Decisions',
  constraint: 'Constraints',
  lesson_learned: 'Lessons Learned',
};

const SOURCE_COLORS: Record<string, string> = {
  human: 'bg-blue-100 text-blue-700',
  agent: 'bg-purple-100 text-purple-700',
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
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

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
    toast('success', 'Context entry added');
  };

  const handleEdit = async (id: string) => {
    if (!editContent.trim()) return;

    const updates: Record<string, any> = { content: editContent.trim() };

    const { data, error } = await supabase
      .from('project_context')
      .update(updates)
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
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const grouped = PROJECT_CONTEXT_CATEGORIES.reduce((acc, cat) => {
    acc[cat] = entries.filter(e => e.category === cat);
    return acc;
  }, {} as Record<ProjectContextCategory, ProjectContext[]>);

  return (
    <div className="flex flex-col max-h-[500px]">
      {/* Content */}
      <div className="flex-1 overflow-y-auto space-y-4">
        {loading ? (
          <p className="text-sm text-zinc-400 text-center py-8">Loading...</p>
        ) : (
          PROJECT_CONTEXT_CATEGORIES.map(cat => {
            const catEntries = grouped[cat];
            const isCollapsed = collapsedCategories.has(cat);

            return (
              <div key={cat}>
                {/* Category header */}
                <div className="flex items-center justify-between mb-2">
                  <button
                    onClick={() => toggleCategory(cat)}
                    className="flex items-center gap-1.5 text-sm font-medium text-zinc-700 hover:text-zinc-900 transition-colors"
                  >
                    {CATEGORY_LABELS[cat]}
                    {catEntries.length > 0 && (
                      <span className="text-zinc-400 font-normal">({catEntries.length})</span>
                    )}
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                  <button
                    onClick={() => {
                      setAddingCategory(cat);
                      setAddContent('');
                    }}
                    className="text-zinc-400 hover:text-zinc-600 transition-colors"
                    title="Add entry"
                  >
                    <Plus size={14} />
                  </button>
                </div>

                {!isCollapsed && (
                  <>
                    {/* Add form for this category */}
                    {addingCategory === cat && (
                      <div className="mb-2 p-3 bg-zinc-50 rounded-lg border border-zinc-200 space-y-2">
                        <Textarea
                          value={addContent}
                          onChange={setAddContent}
                          placeholder="Content..."
                          rows={2}
                          size="sm"
                          autoFocus
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => setAddingCategory(null)}
                            className="px-3 py-1.5 text-xs text-zinc-600 hover:text-zinc-800 transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleAdd}
                            disabled={!addContent.trim()}
                            className="px-3 py-1.5 text-xs bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 disabled:opacity-50 transition-all"
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Entries */}
                    {catEntries.length === 0 && addingCategory !== cat && (
                      <p className="text-xs text-zinc-400 mb-3">No entries yet. Add one to help the AI understand this project.</p>
                    )}

                    {catEntries.map(entry => (
                      <div key={entry.id} className="group mb-2">
                        {editingId === entry.id ? (
                          <div className="p-3 bg-zinc-50 rounded-lg border border-zinc-200 space-y-2">
                            <Textarea
                              value={editContent}
                              onChange={setEditContent}
                              rows={2}
                              size="sm"
                              autoFocus
                            />
                            <div className="flex justify-end gap-2">
                              <button onClick={() => setEditingId(null)} className="p-1 text-zinc-400 hover:text-zinc-600">
                                <X size={14} />
                              </button>
                              <button onClick={() => handleEdit(entry.id)} className="p-1 text-emerald-600 hover:text-emerald-700">
                                <Check size={14} />
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-zinc-800 leading-snug">{entry.content}</p>
                              <div className="flex items-center gap-2 mt-1">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${SOURCE_COLORS[entry.source]}`}>
                                  {entry.source}
                                </span>
                                <span className="text-[10px] text-zinc-400">{timeAgo(entry.updated_at)}</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                              <button onClick={() => startEdit(entry)} className="p-1 text-zinc-400 hover:text-zinc-600">
                                <Pencil size={12} />
                              </button>
                              <button onClick={() => setDeleteTarget(entry.id)} className="p-1 text-zinc-400 hover:text-red-500">
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Remove Entry"
        message="This entry will be deactivated. Are you sure?"
        confirmLabel="Remove"
        variant="danger"
      />
    </div>
  );
}
