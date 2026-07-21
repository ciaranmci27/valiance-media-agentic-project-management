import { z } from 'zod';

// A single worked interval within a time entry.
export const timeSegmentSchema = z.object({
  start: z.string().min(1, 'Segment start is required'),
  end: z.string().nullable(),
});

// Start a live timer (end_time will be null)
export const startTimerSchema = z.object({
  member_id: z.string().uuid('Invalid member'),
  description: z.string().default(''),
  work_type: z.enum(['client', 'internal']).default('client'),
});

// Manual entry: log a past time range
export const createTimeEntrySchema = z.object({
  member_id: z.string().uuid('Invalid member'),
  start_time: z.string().min(1, 'Start time is required'),
  end_time: z.string().min(1, 'End time is required'),
  description: z.string().default(''),
  work_type: z.enum(['client', 'internal']).default('client'),
  timezone: z.string().optional(), // e.g. 'America/Phoenix'
});

// Update an existing entry
export const updateTimeEntrySchema = z.object({
  member_id: z.string().uuid('Invalid member').optional(),
  start_time: z.string().optional(),
  end_time: z.string().nullable().optional(),
  segments: z.array(timeSegmentSchema).optional(),
  description: z.string().optional(),
  work_type: z.enum(['client', 'internal']).optional(),
});
