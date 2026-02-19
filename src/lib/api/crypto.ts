export async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return (
    'pk_live_' +
    Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  );
}
