'use client';

import { useState, useEffect } from 'react';
import Modal from '@/components/ui/Modal';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';

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
    <Modal isOpen={isOpen} onClose={onClose} title={editMode ? 'Edit note' : 'New note'} size="lg" primaryAction={{ label: 'Save note', onClick: () => void handleSave(), busy: saving }}>
      <div className="space-y-4">
        {/* File name + extension */}
        <div className="flex items-center gap-2">
          <TextInput
            value={fileName}
            onChange={setFileName}
            placeholder="File name"
            className="flex-1"
          />
          <div className="flex rounded-lg border border-white/[0.08] overflow-hidden flex-shrink-0">
            <button
              type="button"
              onClick={() => setExtension('.md')}
              className={`px-3 py-2 text-xs font-medium transition-colors ${
                extension === '.md'
                  ? 'bg-brand-600 text-white'
                  : 'bg-surface-raised text-zinc-300 hover:bg-white/[0.03]'
              }`}
            >
              .md
            </button>
            <button
              type="button"
              onClick={() => setExtension('.txt')}
              className={`px-3 py-2 text-xs font-medium transition-colors border-l border-white/[0.08] ${
                extension === '.txt'
                  ? 'bg-brand-600 text-white'
                  : 'bg-surface-raised text-zinc-300 hover:bg-white/[0.03]'
              }`}
            >
              .txt
            </button>
          </div>
        </div>

        {/* Editor */}
        <Textarea
          value={content}
          onChange={setContent}
          placeholder="Start writing"
          rows={12}
          resizable
          inputClassName="font-mono"
        />

      </div>
    </Modal>
  );
}
