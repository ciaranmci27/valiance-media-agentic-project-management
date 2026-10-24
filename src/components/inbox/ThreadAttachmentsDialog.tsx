'use client';

import { Download, Eye, FileText, Image as ImageIcon } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Tooltip } from '@/components/ui/Tooltip';
import { skippedReasonLabel, type InboxAttachment, type InboxMessage } from '@/lib/inbound-email/inbox-types';
import { formatBytes, formatFullTime } from './inbox-badges';

/** Every file in a conversation, the images shown inside its emails included. */
export function threadAttachments(messages: InboxMessage[]): { attachment: InboxAttachment; message: InboxMessage }[] {
  return messages.flatMap((message) => message.attachments.map((attachment) => ({ attachment, message })));
}

const ICON_BUTTON = 'rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/**
 * The conversation's attachments in one list, newest email first: a
 * thumbnail or icon, the name and size, the email it came with, and
 * Preview (images, PDFs, text) and Download. A file that was not stored
 * says why instead.
 */
export function ThreadAttachmentsDialog({ isOpen, onClose, messages, viewUrl, onPreview, onDownload }: {
  isOpen: boolean;
  onClose: () => void;
  messages: InboxMessage[];
  /** Where a stored attachment opens in the browser; null in demo mode. */
  viewUrl: ((attachmentId: string) => string) | null;
  onPreview?: (attachment: InboxAttachment) => void;
  onDownload: (attachment: InboxAttachment) => void;
}) {
  const files = threadAttachments(messages).reverse();
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Attachments (${files.length})`} size="xl">
      {files.length === 0 ? (
        <p className="py-8 text-center text-sm text-zinc-400">This conversation has no attachments.</p>
      ) : (
        <ul className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.07]">
          {files.map(({ attachment, message }) => {
            const sender = (message.original_sender ?? message.from);
            const Icon = attachment.kind === 'image' ? ImageIcon : FileText;
            const thumbnail = attachment.kind === 'image' && attachment.available && viewUrl;
            const previewable = !!onPreview && attachment.available && attachment.kind !== 'other';
            return (
              <li key={attachment.id} className="flex items-center gap-3 px-3 py-2.5">
                {thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a signed storage link, not a static asset
                  <img src={viewUrl(attachment.id)} alt="" loading="lazy" className="h-10 w-10 flex-shrink-0 rounded-md border border-white/[0.08] object-cover" />
                ) : (
                  <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-white/[0.04]">
                    <Icon size={16} className="text-zinc-400" aria-hidden="true" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-100" title={attachment.filename}>{attachment.filename}</p>
                  <p className="truncate text-xs text-zinc-400">
                    {attachment.available ? formatBytes(attachment.size_bytes) : skippedReasonLabel(attachment.skipped_reason)}
                    {' · '}
                    {sender?.name || sender?.address || 'Unknown sender'}, {formatFullTime(message.received_at)}
                  </p>
                </div>
                {attachment.available && (
                  <div className="flex flex-shrink-0 items-center gap-0.5">
                    {previewable && (
                      <Tooltip content="Preview">
                        <button type="button" onClick={() => onPreview!(attachment)} aria-label={`Preview ${attachment.filename}`} className={ICON_BUTTON}>
                          <Eye size={15} aria-hidden="true" />
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip content="Download">
                      <button type="button" onClick={() => onDownload(attachment)} aria-label={`Download ${attachment.filename}`} className={ICON_BUTTON}>
                        <Download size={15} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
