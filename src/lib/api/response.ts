import { NextResponse } from 'next/server';

export function success(data: unknown, status = 200) {
  return NextResponse.json({ success: true, data }, { status });
}

export function created(data: unknown) {
  return NextResponse.json({ success: true, data }, { status: 201 });
}

export function paginated(data: unknown[], meta: { page: number; limit: number; total: number }) {
  return NextResponse.json({
    success: true,
    data,
    meta: {
      page: meta.page,
      limit: meta.limit,
      total: meta.total,
      total_pages: meta.limit > 0 ? Math.ceil(meta.total / meta.limit) : 0,
    },
  });
}

export function errorResponse(
  statusCode: number,
  code: string,
  message: string,
  details?: unknown
) {
  return NextResponse.json(
    {
      success: false,
      error: { code, message, ...(details ? { details } : {}) },
    },
    { status: statusCode }
  );
}
