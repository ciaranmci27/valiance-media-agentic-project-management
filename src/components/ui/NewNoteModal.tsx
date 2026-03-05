'use client';

import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';

interface NewNoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (fileName: string, content: string, mimeType: string) => Promise<void>;
  editMode?: {
    initialFileName: string;
    initialContent: string;
    fileId: string;
  };
}

export function NewNoteModal({ isOpen, onClose, onSave, editMode }: NewNoteModalProps) {
  const [fileName, setFileName] = useState('untitled');
  const [extension, setExtension] = useState<'.md' | '.txt'>('.md');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    if (editMode) {
      const name = editMode.initialFileName;
      const ext = name.endsWith('.txt') ? '.txt' : '.md';
      setExtension(ext);
      setFileName(name.replace(/\.(md|txt)$/, ''));
      setContent(editMode.initialContent);
    } else {
      setFileName('untitled');
      setExtension('.md');
      setContent('');
    }
  }, [isOpen, editMode]);

  const handleSave = async () => {
    const trimmedName = fileName.trim() || 'untitled';
    setSaving(true);
    try {
      const mimeType = extension === '.md' ? 'text/markdown' : 'text/plain';
      await onSave(trimmedName + extension, content, mimeType);
      onClose();
    } catch {
      // error handled by parent
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editMode ? 'Edit Note' : 'New Note'} size="lg">
      <div className="space-y-4">
        {/* File name + extension */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={fileName}
            onChange={e => setFileName(e.target.value)}
            placeholder="File name"
            className="flex-1 px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all"
          />
          <div className="flex rounded-lg border border-zinc-200 overflow-hidden flex-shrink-0">
            <button
              type="button"
              onClick={() => setExtension('.md')}
              className={`px-3 py-2 text-xs font-medium transition-colors ${
                extension === '.md'
                  ? 'bg-brand-600 text-white'
                  : 'bg-white text-zinc-600 hover:bg-zinc-50'
              }`}
            >
              .md
            </button>
            <button
              type="button"
              onClick={() => setExtension('.txt')}
              className={`px-3 py-2 text-xs font-medium transition-colors border-l border-zinc-200 ${
                extension === '.txt'
                  ? 'bg-brand-600 text-white'
                  : 'bg-white text-zinc-600 hover:bg-zinc-50'
              }`}
            >
              .txt
            </button>
          </div>
        </div>

        {/* Editor */}
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder="Start writing..."
          className="w-full min-h-[300px] resize-y px-4 py-3 text-sm font-mono bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all"
        />

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-zinc-600 bg-zinc-100 hover:bg-zinc-200 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50 rounded-lg transition-colors"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
