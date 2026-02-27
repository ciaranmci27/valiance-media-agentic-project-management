'use client';

import { useState, useRef } from 'react';
import {
  Receipt, Plus, Edit2, Trash2, FileDown, DollarSign, X, Check, Upload, File,
  Loader2,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { createClient } from '@/lib/supabase/client';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Select } from '@/components/ui/Select';
import { siteConfig } from '@/site-config';
import { INVOICE_STATUSES, type InvoiceStatus } from '@/lib/types';

interface InvoicesPanelProps {
  projectId: string;
  projectColor?: string;
}

const statusColors: Record<string, string> = {
  draft: 'bg-zinc-100 text-zinc-600',
  sent: 'bg-blue-50 text-blue-700',
  paid: 'bg-emerald-50 text-emerald-700',
  overdue: 'bg-red-50 text-red-700',
  cancelled: 'bg-zinc-100 text-zinc-400',
};

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format YYYY-MM-DD to "Mon D" or "Mon D, YYYY" if year differs from current */
function fmtDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const now = new Date();
  const month = date.toLocaleString('en-US', { month: 'short' });
  return y !== now.getFullYear() ? `${month} ${d}, ${y}` : `${month} ${d}`;
}

export default function InvoicesPanel({ projectId, projectColor }: InvoicesPanelProps) {
  const {
    addInvoice, updateInvoice, deleteInvoice, getInvoicesByProject,
    getProject, updateProject, getTimeEntriesByProject,
  } = useApp();
  const { teamMemberId } = useAuth();
  const invoices = getInvoicesByProject(projectId);
  const project = getProject(projectId);

  // UI state
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Form state
  const [formNumber, setFormNumber] = useState('');
  const [formAmount, setFormAmount] = useState('');
  const [formDate, setFormDate] = useState('');
  const [formDueDate, setFormDueDate] = useState('');
  const [formPaidDate, setFormPaidDate] = useState('');
  const [formStatus, setFormStatus] = useState<InvoiceStatus>('draft');
  const [formDescription, setFormDescription] = useState('');
  const [formFile, setFormFile] = useState<File | null>(null);
  const [existingFileUrl, setExistingFileUrl] = useState<string | null>(null);
  const [existingFileName, setExistingFileName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Budget inline editing
  const [editingRate, setEditingRate] = useState(false);
  const [rateValue, setRateValue] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Calculate totals
  const totalInvoiced = invoices.reduce((sum, inv) => sum + inv.amount, 0);
  const totalPaid = invoices.filter(inv => inv.status === 'paid').reduce((sum, inv) => sum + inv.amount, 0);
  const outstanding = totalInvoiced - totalPaid;

  // Calculate budget from time entries or fixed price
  const timeEntries = getTimeEntriesByProject(projectId);
  const totalHours = timeEntries.reduce((sum, te) => {
    if (!te.end_time) return sum;
    return sum + (new Date(te.end_time).getTime() - new Date(te.start_time).getTime()) / 3_600_000;
  }, 0);

  const isHourly = project?.hourly_tracking ?? false;
  const currentRate = isHourly ? (project?.hourly_rate ?? 0) : (project?.fixed_price ?? 0);
  const budgetTotal = isHourly ? currentRate * totalHours : currentRate;

  const resetForm = () => {
    setFormNumber('');
    setFormAmount('');
    setFormDate('');
    setFormDueDate('');
    setFormPaidDate('');
    setFormStatus('draft');
    setFormDescription('');
    setFormFile(null);
    setExistingFileUrl(null);
    setExistingFileName(null);
  };

  const openAddForm = () => {
    resetForm();
    setEditingId(null);
    const maxNum = invoices.reduce((max, inv) => {
      const match = inv.invoice_number.match(/(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    const nextNum = String(maxNum + 1).padStart(3, '0');
    setFormNumber(`INV-${nextNum}`);
    setFormDate(new Date().toISOString().split('T')[0]);
    setIsAdding(true);
  };

  const handleFileUpload = async (file: File): Promise<{ file_url: string; file_name: string; file_size: number; mime_type: string } | null> => {
    const supabase = createClient();
    const path = `invoices/${projectId}/${Date.now()}-${file.name}`;
    const { error } = await supabase.storage.from('entity-files').upload(path, file);
    if (error) {
      toast('error', 'Failed to upload file');
      return null;
    }
    const { data: { publicUrl } } = supabase.storage.from('entity-files').getPublicUrl(path);
    return { file_url: publicUrl, file_name: file.name, file_size: file.size, mime_type: file.type };
  };

  const handleAdd = async () => {
    if (!formNumber.trim() || !formAmount.trim()) return;
    setSaving(true);

    try {
      let fileData: { file_url: string; file_name: string; file_size: number; mime_type: string } | null = null;
      if (formFile) {
        fileData = await handleFileUpload(formFile);
        if (!fileData) { setSaving(false); return; }
      }

      await addInvoice({
        project_id: projectId,
        invoice_number: formNumber.trim(),
        amount: parseFloat(formAmount) || 0,
        status: formStatus,
        date: formDate,
        due_date: formDueDate || null,
        paid_date: formPaidDate || null,
        description: formDescription.trim(),
        file_url: fileData?.file_url ?? null,
        file_name: fileData?.file_name ?? null,
        file_size: fileData?.file_size ?? null,
        mime_type: fileData?.mime_type ?? null,
        created_by: teamMemberId,
      });

      resetForm();
      setIsAdding(false);
      toast('success', 'Invoice created');
    } finally {
      setSaving(false);
    }
  };

  const startEditing = (invoice: typeof invoices[number]) => {
    setIsAdding(false);
    setEditingId(invoice.id);
    setFormNumber(invoice.invoice_number);
    setFormAmount(String(invoice.amount));
    setFormDate(invoice.date);
    setFormDueDate(invoice.due_date || '');
    setFormPaidDate(invoice.paid_date || '');
    setFormStatus(invoice.status);
    setFormDescription(invoice.description || '');
    setFormFile(null);
    setExistingFileUrl(invoice.file_url);
    setExistingFileName(invoice.file_name);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !formNumber.trim() || !formAmount.trim()) return;
    setSaving(true);

    try {
      let fileData: { file_url: string; file_name: string; file_size: number; mime_type: string } | null = null;
      if (formFile) {
        fileData = await handleFileUpload(formFile);
        if (!fileData) { setSaving(false); return; }
      }

      const updates: Record<string, unknown> = {
        invoice_number: formNumber.trim(),
        amount: parseFloat(formAmount) || 0,
        status: formStatus,
        date: formDate,
        due_date: formDueDate || null,
        paid_date: formPaidDate || null,
        description: formDescription.trim(),
      };

      if (fileData) {
        updates.file_url = fileData.file_url;
        updates.file_name = fileData.file_name;
        updates.file_size = fileData.file_size;
        updates.mime_type = fileData.mime_type;
      }

      await updateInvoice(editingId, updates);

      resetForm();
      setEditingId(null);
      toast('success', 'Invoice updated');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    resetForm();
    setEditingId(null);
    setIsAdding(false);
  };

  const executeDelete = () => {
    if (deleteTarget) {
      deleteInvoice(deleteTarget);
      toast('success', 'Invoice deleted');
    }
  };

  const handleRateBlur = () => {
    setEditingRate(false);
    const parsed = parseFloat(rateValue);
    if (isNaN(parsed) || parsed < 0) return;
    if (isHourly) {
      updateProject(projectId, { hourly_rate: parsed });
    } else {
      updateProject(projectId, { fixed_price: parsed });
    }
  };

  const handleRateKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRateBlur();
    } else if (e.key === 'Escape') {
      setEditingRate(false);
    }
  };

  // Shared form fields renderer
  const renderForm = (mode: 'add' | 'edit') => (
    <div className={mode === 'add' ? 'border border-brand-200 bg-brand-50/30 rounded-lg p-4 space-y-3' : 'space-y-3'}>
      <div className="grid grid-cols-3 gap-2">
        <input
          autoFocus
          type="text"
          value={formNumber}
          onChange={e => setFormNumber(e.target.value)}
          placeholder="Invoice #"
          className="min-w-0 px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all"
        />
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">$</span>
          <input
            type="number"
            value={formAmount}
            onChange={e => setFormAmount(e.target.value)}
            placeholder="0.00"
            step="0.01"
            min="0"
            className="w-full pl-7 pr-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all"
          />
        </div>
        <Select
          value={formStatus}
          onChange={v => setFormStatus(v as InvoiceStatus)}
          options={INVOICE_STATUSES.map(s => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-500">Invoice Date</label>
          <input
            type="date"
            value={formDate}
            onChange={e => setFormDate(e.target.value)}
            className="px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-500">Due Date</label>
          <input
            type="date"
            value={formDueDate}
            onChange={e => setFormDueDate(e.target.value)}
            className="px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-500">Paid Date</label>
          <input
            type="date"
            value={formPaidDate}
            onChange={e => setFormPaidDate(e.target.value)}
            className="px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all"
          />
        </div>
      </div>
      <textarea
        value={formDescription}
        onChange={e => setFormDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={2}
        className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all resize-none"
      />

      {/* File upload */}
      <div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) {
              setFormFile(file);
              setExistingFileUrl(null);
              setExistingFileName(null);
            }
          }}
        />
        {formFile ? (
          <div className="flex items-center gap-2 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg">
            <File size={14} className="text-zinc-400 flex-shrink-0" />
            <span className="text-sm text-zinc-700 truncate flex-1">{formFile.name}</span>
            <button
              onClick={() => setFormFile(null)}
              className="p-0.5 text-zinc-400 hover:text-red-500 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        ) : existingFileUrl ? (
          <div className="flex items-center gap-2 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg">
            <File size={14} className="text-zinc-400 flex-shrink-0" />
            <span className="text-sm text-zinc-700 truncate flex-1">{existingFileName || 'Attached file'}</span>
            <button
              onClick={() => { setExistingFileUrl(null); setExistingFileName(null); }}
              className="p-0.5 text-zinc-400 hover:text-red-500 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 border border-dashed border-zinc-300 hover:border-zinc-400 rounded-lg transition-colors"
          >
            <Upload size={14} />
            Attach file
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={handleCancel}
          className="px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={mode === 'add' ? handleAdd : handleSaveEdit}
          disabled={!formNumber.trim() || !formAmount.trim() || saving}
          className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving && <Loader2 size={13} className="animate-spin" />}
          {mode === 'add' ? 'Save' : 'Update'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col max-h-[600px]">
      {/* Header */}
      <div className="px-5 py-4 flex items-center justify-between flex-shrink-0 border-b border-zinc-100">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 bg-brand-50 rounded-md">
            <Receipt size={16} className="text-brand-600" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">
              Invoices
              {invoices.length > 0 && (
                <span className="ml-1.5 text-xs font-medium text-zinc-400">({invoices.length})</span>
              )}
            </h3>
            <p className="text-xs text-zinc-500">Track payments and billing</p>
          </div>
        </div>
        <button
          onClick={openAddForm}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
        >
          <Plus size={14} />
          Add
        </button>
      </div>

      <div className="flex-1 flex flex-col overflow-y-auto">
        {/* Balance Summary */}
        {!isAdding && !editingId && <div className="px-5 py-3 border-b border-zinc-100 bg-zinc-50/50 overflow-x-auto flex-shrink-0">
          <div className="flex gap-4 min-w-max">
            <div className="shrink-0">
              <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Total Invoiced</p>
              <p className="text-sm font-semibold text-zinc-900">${formatCurrency(totalInvoiced)}</p>
            </div>
            <div className="shrink-0">
              <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Total Paid</p>
              <p className="text-sm font-semibold text-emerald-600">${formatCurrency(totalPaid)}</p>
            </div>
            <div className="shrink-0">
              <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">Outstanding</p>
              <p className="text-sm font-semibold text-amber-600">${formatCurrency(outstanding)}</p>
            </div>
            <div className="shrink-0">
              <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-0.5">
                {isHourly ? 'Budget' : 'Fixed Price'}
              </p>
              <div className="flex items-center gap-1.5">
                {isHourly ? (
                  <>
                    <p className="text-sm font-semibold text-zinc-900">${formatCurrency(budgetTotal)}</p>
                    <span className="text-[10px] text-zinc-400">({totalHours.toFixed(1)}h</span>
                    <span className="text-[10px] text-zinc-400">×</span>
                  </>
                ) : null}
                {editingRate ? (
                  <div className="relative inline-flex items-center">
                    <span className="absolute left-1.5 text-xs text-zinc-400">$</span>
                    <input
                      autoFocus
                      type="number"
                      value={rateValue}
                      onChange={e => setRateValue(e.target.value)}
                      onBlur={handleRateBlur}
                      onKeyDown={handleRateKeyDown}
                      step="0.01"
                      min="0"
                      className="w-20 pl-5 pr-1.5 py-0.5 text-xs bg-white border border-brand-300 rounded outline-none focus:ring-1 focus:ring-brand-200"
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => { setEditingRate(true); setRateValue(String(currentRate)); }}
                    className="text-xs text-zinc-500 hover:text-brand-600 transition-colors cursor-pointer underline decoration-dashed underline-offset-2"
                    title={isHourly ? 'Edit hourly rate' : 'Edit fixed price'}
                  >
                    {isHourly ? `$${formatCurrency(currentRate)}/h)` : `$${formatCurrency(currentRate)}`}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>}
        {/* Add form */}
        {isAdding && !editingId && (
          <div className="m-5">
            {renderForm('add')}
          </div>
        )}

        {/* Invoice list */}
        {invoices.length > 0 ? (
          <div className="flex-1 overflow-y-auto p-5 space-y-3">
            {invoices.sort((a, b) => b.date.localeCompare(a.date)).map(invoice => {
              const isEditing = editingId === invoice.id;

              if (isEditing) {
                return (
                  <div
                    key={invoice.id}
                    className="p-3 rounded-lg border border-brand-200 bg-brand-50/30"
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${statusColors[invoice.status]}`}>
                        {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                      </span>
                      <span className="text-sm font-semibold text-zinc-900">{invoice.invoice_number}</span>
                      <span className="text-xs text-zinc-400">Editing</span>
                    </div>
                    {renderForm('edit')}
                  </div>
                );
              }

              return (
                <div
                  key={invoice.id}
                  className="group p-3 rounded-lg border border-zinc-200 hover:border-zinc-300 transition-colors"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="relative inline-flex items-center">
                        <span className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-2 py-0.5 text-xs font-medium rounded-full ${statusColors[invoice.status]}`}>
                          {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                        </span>
                        <div className="[&_button]:!bg-transparent [&_button]:!border-transparent [&_button]:!shadow-none [&_button]:!ring-0 [&_button]:!text-transparent [&_button]:!px-2 [&_button]:!py-0.5 [&_button]:!text-xs [&_svg]:!text-transparent">
                          <Select
                            size="sm"
                            value={invoice.status}
                            onChange={v => updateInvoice(invoice.id, { status: v as InvoiceStatus })}
                            options={INVOICE_STATUSES.map(s => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))}
                          />
                        </div>
                      </div>
                      <span className="text-sm font-semibold text-zinc-900">{invoice.invoice_number}</span>
                    </div>
                    <span className="text-sm font-semibold text-zinc-900">
                      ${invoice.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 text-xs text-zinc-500">
                      <span>Issued: {fmtDate(invoice.date)}</span>
                      {invoice.due_date && invoice.due_date !== invoice.date && <span>Due: {fmtDate(invoice.due_date)}</span>}
                      {invoice.paid_date && <span className="text-emerald-600">Paid: {fmtDate(invoice.paid_date)}</span>}
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => startEditing(invoice)}
                        className="p-1.5 text-zinc-400 hover:text-brand-600 transition-colors rounded-md hover:bg-zinc-50"
                      >
                        <Edit2 size={13} />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(invoice.id)}
                        className="p-1.5 text-zinc-400 hover:text-red-500 transition-colors rounded-md hover:bg-zinc-50"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  {invoice.description && (
                    <p className="mt-1.5 text-xs text-zinc-600 line-clamp-2">{invoice.description}</p>
                  )}
                  {invoice.file_url && (
                    <a
                      href={invoice.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 mt-2 text-xs text-brand-600 hover:text-brand-700"
                    >
                      <FileDown size={12} />
                      {invoice.file_name || 'Download'}
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        ) : !isAdding ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
              <Receipt size={18} className="text-zinc-400" />
            </div>
            <p className="text-sm font-medium text-zinc-500">No invoices yet</p>
            <p className="text-xs text-zinc-400 mt-1">Create invoices to track billing for this project</p>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={executeDelete}
        title="Delete Invoice"
        message="Are you sure you want to delete this invoice? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
