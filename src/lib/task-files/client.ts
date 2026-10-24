import type { TaskFileCandidates, TaskFileView } from './service';

export type { TaskFileCandidates, TaskFileView };

/** The bucket's limit; checked before uploading so a big file fails at once. */
export const MAX_TASK_FILE_BYTES = 50 * 1024 * 1024;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });
  const body = await response.json().catch(() => null) as { data?: T; error?: string } | null;
  if (!response.ok || !body || body.data === undefined) throw new Error(body?.error || 'Something went wrong. Try again.');
  return body.data;
}

const base = (taskId: string) => `/api/workspace/tasks/${taskId}/files`;

/** Opens an image, PDF or text file in the browser (a redirect to a fresh link). */
export const taskFileViewUrl = (taskId: string, fileId: string) => `${base(taskId)}/${fileId}/view`;

export const listTaskFiles = (taskId: string) => call<TaskFileView[]>(base(taskId));

export const taskFileCandidates = (taskId: string) => call<TaskFileCandidates>(`${base(taskId)}/candidates`);

export const linkTaskFile = (taskId: string, source: { email_attachment_id: string } | { entity_file_id: string }) =>
  call<TaskFileView>(base(taskId), { method: 'POST', body: JSON.stringify(source) });

export const trashTaskFile = (taskId: string, fileId: string) =>
  call<{ deleted: true }>(`${base(taskId)}/${fileId}`, { method: 'DELETE' });

/**
 * Uploads one file: the bytes go straight to Storage through a two-hour
 * upload link, then the server hashes them and adds them to the task.
 */
export async function uploadTaskFile(taskId: string, file: File): Promise<TaskFileView> {
  if (file.size > MAX_TASK_FILE_BYTES) throw new Error(`${file.name} is over 50 MB`);
  if (file.size === 0) throw new Error(`${file.name} is empty`);
  const link = await call<{ upload_id: string; upload_url: string }>(`${base(taskId)}/uploads`, { method: 'POST' });
  const put = await fetch(link.upload_url, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-upsert': 'false' },
    body: file,
  });
  if (!put.ok) throw new Error(`Could not upload ${file.name}`);
  return call<TaskFileView>(base(taskId), {
    method: 'POST',
    body: JSON.stringify({ upload_id: link.upload_id, name: file.name, ...(file.type ? { mime_type: file.type } : {}) }),
  });
}

/** Saves a file through a one-minute download link. */
export async function downloadTaskFile(taskId: string, fileId: string): Promise<void> {
  const link = await call<{ url: string; name: string }>(`${base(taskId)}/${fileId}/url`);
  const anchor = document.createElement('a');
  anchor.href = link.url;
  anchor.rel = 'noopener noreferrer';
  anchor.download = link.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
