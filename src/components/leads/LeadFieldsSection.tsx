'use client';

import { useState, useEffect } from 'react';
import { useApp } from '@/lib/store';
import { LEAD_FIELD_DEFINITIONS, LeadFieldDefinition, LeadFieldCategory } from '@/lib/types';
import Modal from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import {
  Plus, X, ExternalLink, Edit, Trash2, Check,
  Globe, Briefcase, BarChart3, Lightbulb,
} from 'lucide-react';

const CATEGORY_ORDER: LeadFieldCategory[] = ['Business Identity', 'Opportunity', 'Assessment', 'Strategy'];

const CATEGORY_CONFIG: Record<LeadFieldCategory, {
  icon: React.ReactNode;
  iconBg: string;
  iconText: string;
  border: string;
  tagBg: string;
}> = {
  'Business Identity': {
    icon: <Globe size={13} />,
    iconBg: 'bg-white/[0.06]',
    iconText: 'text-zinc-400',
    border: 'border-l-zinc-300',
    tagBg: 'bg-white/[0.06] text-zinc-300 border-white/[0.08]',
  },
  'Opportunity': {
    icon: <Briefcase size={13} />,
    iconBg: 'bg-white/[0.06]',
    iconText: 'text-zinc-400',
    border: 'border-l-zinc-300',
    tagBg: 'bg-white/[0.06] text-zinc-300 border-white/[0.08]',
  },
  'Assessment': {
    icon: <BarChart3 size={13} />,
    iconBg: 'bg-white/[0.06]',
    iconText: 'text-zinc-400',
    border: 'border-l-zinc-300',
    tagBg: 'bg-white/[0.06] text-zinc-300 border-white/[0.08]',
  },
  'Strategy': {
    icon: <Lightbulb size={13} />,
    iconBg: 'bg-white/[0.06]',
    iconText: 'text-zinc-400',
    border: 'border-l-zinc-300',
    tagBg: 'bg-white/[0.06] text-zinc-300 border-white/[0.08]',
  },
};

const PRIORITY_COLORS: Record<string, { variant: 'danger' | 'warning' | 'info'; }> = {
  Hot: { variant: 'danger' },
  Warm: { variant: 'warning' },
  Cold: { variant: 'info' },
};

interface LeadFieldsSectionProps {
  leadId: string;
  readOnly?: boolean;
}

export function LeadFieldsSection({ leadId, readOnly = false }: LeadFieldsSectionProps) {
  const { getFieldsByLead, setLeadField, deleteLeadField } = useApp();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const fields = getFieldsByLead(leadId);
  const existingKeys = new Set(fields.map(f => f.field_key));

  // Group existing fields by category
  const grouped = CATEGORY_ORDER.map(cat => {
    const defs = LEAD_FIELD_DEFINITIONS.filter(d => d.category === cat && existingKeys.has(d.key));
    return { category: cat, definitions: defs };
  }).filter(g => g.definitions.length > 0);

  const handleAddField = (def: LeadFieldDefinition) => {
    setLeadField(leadId, def.key, '');
    setIsAddOpen(false);
    setEditingKey(def.key);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-white">Lead Details</h2>
        {!readOnly && <Button
          onClick={() => setIsAddOpen(true)}
          icon={<Plus size={16} />}
        >
          Add Field
        </Button>}
      </div>

      {grouped.length > 0 ? (
        <div className="space-y-4">
          {grouped.map(({ category, definitions }) => {
            const config = CATEGORY_CONFIG[category];

            // Split fields: textareas are full-width, rest go in grid
            const compactDefs = definitions.filter(d => d.type !== 'textarea');
            const textareaDefs = definitions.filter(d => d.type === 'textarea');

            return (
              <div
                key={category}
                className={`glass-card rounded-xl border-l-4 ${config.border} overflow-hidden`}
              >
                {/* Category header */}
                <div className="flex items-center gap-2.5 px-4 py-2.5 bg-white/[0.03] border-b border-white/[0.06]">
                  <span className={`flex items-center justify-center w-6 h-6 rounded-md ${config.iconBg} ${config.iconText}`}>
                    {config.icon}
                  </span>
                  <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wide">{category}</span>
                </div>

                {/* Compact fields in 2-col grid */}
                {compactDefs.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 divide-white/[0.06]">
                    {compactDefs.map((def, i) => {
                      const field = fields.find(f => f.field_key === def.key);
                      if (!field) return null;
                      // Add a top border on items after the first row (index >= 2)
                      const needsTopBorder = i >= 2;
                      return (
                        <div
                          key={def.key}
                          className={`${needsTopBorder ? 'sm:border-t sm:border-white/[0.06]' : ''} ${i % 2 === 0 ? 'sm:border-r sm:border-white/[0.06]' : ''}`}
                        >
                          <LeadFieldItem
                            definition={def}
                            value={field.value}
                            fieldId={field.id}
                            leadId={leadId}
                            isEditing={editingKey === def.key}
                            onStartEdit={() => setEditingKey(def.key)}
                            onStopEdit={() => setEditingKey(null)}
                            onSave={(val) => {
                              setLeadField(leadId, def.key, val);
                              setEditingKey(null);
                            }}
                            onRemove={() => deleteLeadField(field.id, leadId)}
                            categoryConfig={config}
                            readOnly={readOnly}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Textarea fields full-width below the grid */}
                {textareaDefs.length > 0 && (
                  <div className={`divide-y divide-white/[0.06] ${compactDefs.length > 0 ? 'border-t border-white/[0.06]' : ''}`}>
                    {textareaDefs.map(def => {
                      const field = fields.find(f => f.field_key === def.key);
                      if (!field) return null;
                      return (
                        <LeadFieldItem
                          key={def.key}
                          definition={def}
                          value={field.value}
                          fieldId={field.id}
                          leadId={leadId}
                          isEditing={editingKey === def.key}
                          onStartEdit={() => setEditingKey(def.key)}
                          onStopEdit={() => setEditingKey(null)}
                          onSave={(val) => {
                            setLeadField(leadId, def.key, val);
                            setEditingKey(null);
                          }}
                          onRemove={() => deleteLeadField(field.id, leadId)}
                          categoryConfig={config}
                          readOnly={readOnly}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="glass-card rounded-xl flex flex-col items-center justify-center p-8 text-center">
          <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
            <Briefcase size={18} className="text-zinc-500" />
          </div>
          <p className="text-sm font-medium text-zinc-400">No details added yet</p>
          <p className="text-xs text-zinc-500 mt-1">Add fields to track lead information</p>
        </div>
      )}

      <AddFieldDropdown
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        existingKeys={existingKeys}
        onSelect={handleAddField}
      />
    </div>
  );
}

// ============================================================
// LeadFieldItem
// ============================================================

interface LeadFieldItemProps {
  definition: LeadFieldDefinition;
  value: string;
  fieldId: string;
  leadId: string;
  isEditing: boolean;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onSave: (value: string) => void;
  onRemove: () => void;
  categoryConfig: (typeof CATEGORY_CONFIG)[LeadFieldCategory];
  readOnly: boolean;
}

function LeadFieldItem({ definition, value, isEditing, onStartEdit, onStopEdit, onSave, onRemove, categoryConfig, readOnly }: LeadFieldItemProps) {
  const [editValue, setEditValue] = useState(value);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (isEditing) {
      setEditValue(value);
    }
  }, [isEditing, value]);

  const handleSave = () => {
    onSave(editValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && definition.type !== 'textarea') {
      handleSave();
    }
    if (e.key === 'Escape') {
      onStopEdit();
    }
  };

  // Display mode
  if (!isEditing) {
    return (
      <div className="flex items-start justify-between px-4 py-3 group hover:bg-white/[0.03] transition-colors">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wider mb-1.5 text-zinc-500">{definition.label}</p>
          <FieldValueDisplay definition={definition} value={value} categoryConfig={categoryConfig} />
        </div>
        {!readOnly && <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity ml-2 flex-shrink-0">
          <button
            onClick={onStartEdit}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-all"
          >
            <Edit size={14} />
          </button>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/15 transition-all"
          >
            <Trash2 size={14} />
          </button>
        </div>}
        {!readOnly && <ConfirmDialog
          isOpen={showDeleteConfirm}
          onClose={() => setShowDeleteConfirm(false)}
          onConfirm={onRemove}
          title="Delete Field"
          message={`Remove the "${definition.label}" field from this lead?`}
          confirmLabel="Delete"
          variant="danger"
        />}
      </div>
    );
  }

  // Edit mode
  return (
    <div className="px-4 py-3 bg-brand-500/15">
      <p className="text-[11px] font-medium uppercase tracking-wider mb-1.5 text-zinc-500">{definition.label}</p>
      {definition.type === 'text' || definition.type === 'url' ? (
        <div className="flex items-center gap-2">
          <TextInput
            type={definition.type === 'url' ? 'url' : 'text'}
            value={editValue}
            onChange={setEditValue}
            onKeyDown={handleKeyDown}
            placeholder={definition.placeholder || ''}
            size="sm"
            autoFocus
            className="flex-1"
          />
          <button onClick={handleSave} className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/15 transition-all">
            <Check size={16} />
          </button>
          <button onClick={onStopEdit} className="p-1.5 rounded-lg text-zinc-500 hover:bg-white/[0.06] transition-all">
            <X size={16} />
          </button>
        </div>
      ) : definition.type === 'textarea' ? (
        <div className="space-y-2">
          <Textarea
            value={editValue}
            onChange={setEditValue}
            placeholder={definition.placeholder || ''}
            rows={3}
            size="sm"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button onClick={onStopEdit} className="px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.06] rounded-lg transition-colors">
              Cancel
            </button>
            <button onClick={handleSave} className="px-3 py-1.5 text-xs text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors">
              Save
            </button>
          </div>
        </div>
      ) : definition.type === 'select' ? (
        <SelectEditor
          options={definition.options || []}
          value={editValue}
          onSave={onSave}
          onCancel={onStopEdit}
          fieldKey={definition.key}
        />
      ) : definition.type === 'multi_select' ? (
        <MultiSelectEditor
          options={definition.options || []}
          value={editValue}
          allowCustom={definition.allowCustom || false}
          onSave={onSave}
          onCancel={onStopEdit}
        />
      ) : null}
    </div>
  );
}

// ============================================================
// FieldValueDisplay
// ============================================================

function FieldValueDisplay({
  definition,
  value,
  categoryConfig,
}: {
  definition: LeadFieldDefinition;
  value: string;
  categoryConfig: (typeof CATEGORY_CONFIG)[LeadFieldCategory];
}) {
  if (!value) {
    return <p className="text-sm text-zinc-500 italic">Not set</p>;
  }

  switch (definition.type) {
    case 'url':
      return (
        <a
          href={value.startsWith('http') ? value : `https://${value}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-brand-300 hover:text-brand-300 flex items-center gap-1.5 transition-colors"
        >
          {value.replace(/^https?:\/\//, '')}
          <ExternalLink size={12} />
        </a>
      );

    case 'select':
      if (definition.key === 'priority') {
        const colors = PRIORITY_COLORS[value];
        return <Badge variant={colors?.variant || 'default'}>{value}</Badge>;
      }
      return <p className="text-sm font-medium text-zinc-100">{value}</p>;

    case 'multi_select': {
      let tags: string[] = [];
      try {
        tags = JSON.parse(value);
      } catch {
        tags = value ? [value] : [];
      }
      if (tags.length === 0) return <p className="text-sm text-zinc-500 italic">Not set</p>;

      // Pros get a subtle green tint, Cons subtle red, everything else neutral
      const isPros = definition.key === 'pros';
      const isCons = definition.key === 'cons';
      const tagClass = isPros
        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
        : isCons
        ? 'bg-red-500/15 text-red-300 border border-red-500/30'
        : `border ${categoryConfig.tagBg}`;

      return (
        <div className="flex flex-wrap gap-1.5">
          {tags.map(tag => (
            <span key={tag} className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${tagClass}`}>
              {tag}
            </span>
          ))}
        </div>
      );
    }

    case 'textarea':
      return <p className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">{value}</p>;

    default:
      return <p className="text-sm text-zinc-100">{value}</p>;
  }
}

// ============================================================
// SelectEditor
// ============================================================

function SelectEditor({
  options,
  value,
  onSave,
  onCancel,
  fieldKey,
}: {
  options: string[];
  value: string;
  onSave: (val: string) => void;
  onCancel: () => void;
  fieldKey: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {options.map(opt => {
          const isSelected = value === opt;
          let colorClass = isSelected
            ? 'bg-brand-500/15 text-brand-300 border-brand-500/30'
            : 'bg-surface-raised text-zinc-300 border-white/[0.08] hover:border-white/[0.12] hover:bg-white/[0.03]';

          // Priority gets special colors
          if (fieldKey === 'priority' && isSelected) {
            const pc = PRIORITY_COLORS[opt];
            if (pc) {
              colorClass = pc.variant === 'danger'
                ? 'bg-red-500/15 text-red-300 border-red-500/30'
                : pc.variant === 'warning'
                ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                : 'bg-blue-500/15 text-blue-300 border-blue-500/30';
            }
          }

          return (
            <button
              key={opt}
              onClick={() => onSave(opt)}
              className={`px-3 py-1.5 text-xs font-medium border rounded-lg transition-all ${colorClass}`}
            >
              {opt}
            </button>
          );
        })}
      </div>
      <div className="flex justify-end">
        <button onClick={onCancel} className="px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.06] rounded-lg transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ============================================================
// MultiSelectEditor
// ============================================================

function MultiSelectEditor({
  options,
  value,
  allowCustom,
  onSave,
  onCancel,
}: {
  options: string[];
  value: string;
  allowCustom: boolean;
  onSave: (val: string) => void;
  onCancel: () => void;
}) {
  let initial: string[] = [];
  try {
    initial = JSON.parse(value);
  } catch {
    initial = value ? [value] : [];
  }

  const [selected, setSelected] = useState<string[]>(initial);
  const [customInput, setCustomInput] = useState('');

  const toggle = (opt: string) => {
    setSelected(prev =>
      prev.includes(opt) ? prev.filter(s => s !== opt) : [...prev, opt]
    );
  };

  const addCustom = () => {
    const trimmed = customInput.trim();
    if (trimmed && !selected.includes(trimmed)) {
      setSelected(prev => [...prev, trimmed]);
      setCustomInput('');
    }
  };

  const handleCustomKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCustom();
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {options.map(opt => {
          const isSelected = selected.includes(opt);
          return (
            <button
              key={opt}
              onClick={() => toggle(opt)}
              className={`px-2.5 py-1 text-xs font-medium border rounded-full transition-all ${
                isSelected
                  ? 'bg-brand-500/15 text-brand-300 border-brand-500/30'
                  : 'bg-surface-raised text-zinc-300 border-white/[0.08] hover:border-white/[0.12]'
              }`}
            >
              {isSelected && <Check size={10} className="inline mr-1" />}
              {opt}
            </button>
          );
        })}
      </div>

      {/* Custom tags that aren't in options */}
      {selected.filter(s => !options.includes(s)).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.filter(s => !options.includes(s)).map(tag => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-white/[0.06] text-zinc-300 border border-white/[0.08] rounded-full"
            >
              {tag}
              <button onClick={() => setSelected(prev => prev.filter(s => s !== tag))} className="hover:text-violet-900">
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {allowCustom && (
        <div className="flex items-center gap-2">
          <TextInput
            value={customInput}
            onChange={setCustomInput}
            onKeyDown={handleCustomKeyDown}
            placeholder="Add custom tag..."
            size="sm"
            className="flex-1"
          />
          <button
            onClick={addCustom}
            disabled={!customInput.trim()}
            className="px-2.5 py-1.5 text-xs font-medium text-brand-300 hover:bg-brand-500/15 rounded-lg transition-colors disabled:opacity-50"
          >
            Add
          </button>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.06] rounded-lg transition-colors">
          Cancel
        </button>
        <button
          onClick={() => onSave(JSON.stringify(selected))}
          className="px-3 py-1.5 text-xs text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ============================================================
// AddFieldDropdown (Modal)
// ============================================================

function AddFieldDropdown({
  isOpen,
  onClose,
  existingKeys,
  onSelect,
}: {
  isOpen: boolean;
  onClose: () => void;
  existingKeys: Set<string>;
  onSelect: (def: LeadFieldDefinition) => void;
}) {
  const available = LEAD_FIELD_DEFINITIONS.filter(d => !existingKeys.has(d.key));

  const grouped = CATEGORY_ORDER.map(cat => ({
    category: cat,
    definitions: available.filter(d => d.category === cat),
  })).filter(g => g.definitions.length > 0);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Field" size="sm">
      {grouped.length > 0 ? (
        <div className="space-y-3 max-h-[60vh] overflow-y-auto -mx-2 px-2">
          {grouped.map(({ category, definitions }) => {
            const config = CATEGORY_CONFIG[category];
            return (
              <div key={category}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`flex items-center justify-center w-5 h-5 rounded ${config.iconBg} ${config.iconText}`}>
                    {config.icon}
                  </span>
                  <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wide">{category}</span>
                </div>
                <div className="space-y-0.5">
                  {definitions.map(def => (
                    <button
                      key={def.key}
                      onClick={() => onSelect(def)}
                      className="w-full flex items-center justify-between px-3 py-2 text-sm text-zinc-300 hover:bg-brand-500/15 hover:text-brand-300 rounded-lg transition-colors"
                    >
                      <span>{def.label}</span>
                      <span className="text-xs text-zinc-500">
                        {def.type === 'multi_select' ? 'tags' : def.type}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-6 text-zinc-400">
          <p className="text-sm">All fields have been added</p>
        </div>
      )}
    </Modal>
  );
}
