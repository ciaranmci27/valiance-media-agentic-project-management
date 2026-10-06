/** "<a@b> <c@d>" (In-Reply-To, References) into ["a@b", "c@d"], last 100 kept. */
export function parseMessageIdList(value: string | null | undefined): string[] {
  if (!value) return [];
  const bracketed = value.match(/<[^<>\s]+>/g);
  const ids = bracketed ? bracketed.map((id) => id.slice(1, -1)) : value.split(/[\s,]+/);
  return ids.map((id) => id.trim()).filter((id) => id.length > 0 && id.length <= 998).slice(-100);
}
