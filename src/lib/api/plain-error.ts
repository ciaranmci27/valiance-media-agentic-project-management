import { NextResponse } from 'next/server';

/**
 * A database error for a session route, in plain words (deep security
 * review of 2.0.50, finding 13). The raw message names tables, columns,
 * constraints and policies, which tells a caller how the database is built,
 * so it goes to the server log only. The app's own raised words (a check or
 * trigger that says RAISE EXCEPTION 'This time entry is locked', code P0001)
 * are meant for people and pass through.
 */
export const PLAIN_DB_ERROR = 'Something went wrong. Try again.';

export function plainDbMessage(error: { code?: string | null; message?: string | null } | null | undefined): string {
  if (error?.code === 'P0001' && error.message) return error.message;
  return PLAIN_DB_ERROR;
}

export function plainDbError(error: { code?: string | null; message?: string | null } | null | undefined, status = 500): NextResponse {
  console.error('[api] database error:', error);
  return NextResponse.json({ error: plainDbMessage(error) }, { status });
}
