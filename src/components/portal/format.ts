import { createElement, type CSSProperties } from 'react';
import { Archive, File, FileText, Globe, Image as ImageIcon, type LucideIcon, type LucideProps } from 'lucide-react';

/** What the shared FilePreviewModal needs to open a file. */
export type PreviewFile = { id?: string; name: string; file_url: string; mime_type: string };

/** Stagger delay for `.vm-rise`. */
export function rise(seconds: number): CSSProperties {
  return { '--d': `${seconds}s` } as CSSProperties;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (seconds < 60) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (weeks < 5) return `${weeks}w ago`;
  if (months < 12) return `${months}mo ago`;
  return formatDate(dateStr);
}

/** "Aug 12, 2026" from an ISO timestamp. */
export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Aug 12, 2026" from a YYYY-MM-DD date, read in local time so it never shifts a day. */
export function formatDay(ymd: string): string {
  return formatDate(`${ymd}T00:00:00`);
}

/** "Aug 3" from a Date, for chart axes where the year is implied. */
export function formatMonthDay(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function formatBreakDuration(seconds: number): string {
  if (seconds < 60) return '< 1m';
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Fractional hours (1.458) as "1h 27m" so the client can reconcile it against the visible range. */
export function formatHoursMinutes(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  if (totalMinutes === 0) return '0m';
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Whole dollars stay whole ("1,200"); anything with cents shows two decimals. */
/** Whole dollars. Cents belong to invoice amounts only, which format themselves. */
export function formatMoney(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function getFileIcon(mimeType: string): LucideIcon {
  if (mimeType === 'text/html') return Globe;
  if (mimeType.startsWith('image/')) return ImageIcon;
  if (mimeType === 'application/pdf') return FileText;
  if (mimeType.includes('zip') || mimeType.includes('archive')) return Archive;
  return File;
}

/** The lucide icon for a mime type, rendered with the given props. */
export function FileTypeIcon({ mimeType, ...props }: { mimeType: string } & LucideProps) {
  return createElement(getFileIcon(mimeType), props);
}

/** A short human label for a mime type, for the file viewer's top bar. */
export function describeMime(mimeType: string): string {
  if (mimeType === 'text/html') return 'HTML';
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.startsWith('text/')) return 'Text';
  return mimeType;
}

/** Fetches the file as a blob and saves it, so cross-origin URLs download instead of navigating. */
export async function downloadFile(url: string, name: string): Promise<void> {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = objectUrl;
    el.download = name;
    document.body.appendChild(el);
    el.click();
    el.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    // silent: the file is still reachable through preview
  }
}
