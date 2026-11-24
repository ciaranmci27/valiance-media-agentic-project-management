import { z } from 'zod';

/**
 * Groups: named sets of people and agents (Finance, Support, Platform) that
 * stand wherever one member is a target today: a question or approval asked
 * to a group (any member answers), an agent escalating to a group, a group
 * owning an agent. A member is a group's member or lead; leads are listed
 * first and are who escalationTarget picks when one person is needed.
 * Client-safe: no server code here.
 */

export const GROUP_ROLES = ['member', 'lead'] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

export const GROUP_NAME_MAX = 100;
export const GROUP_DESCRIPTION_MAX = 2000;
export const GROUP_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Members added or listed in one call. */
export const GROUP_MEMBERS_BATCH_MAX = 500;

/** A slug from a name: "Finance & Ops" reads finance-ops. Empty when nothing is left. */
export function slugifyGroupName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

const uuid = (what: string) => z.uuid(`${what} must be a uuid`);
const slug = z.string().trim().regex(GROUP_SLUG_PATTERN, 'A slug is lowercase letters, numbers and dashes, 63 characters at most');

export const createGroupSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(GROUP_NAME_MAX, `Name must be ${GROUP_NAME_MAX} characters or fewer`),
  slug: slug.optional(),
  description: z.string().trim().max(GROUP_DESCRIPTION_MAX, `Description must be ${GROUP_DESCRIPTION_MAX} characters or fewer`).optional(),
  external_id: z.string().trim().min(1).max(255).nullable().optional(),
  member_ids: z.array(uuid('member_ids')).max(GROUP_MEMBERS_BATCH_MAX).optional(),
  lead_ids: z.array(uuid('lead_ids')).max(GROUP_MEMBERS_BATCH_MAX).optional(),
}).strict();
export type CreateGroupInput = z.infer<typeof createGroupSchema>;

export const updateGroupSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(GROUP_NAME_MAX).optional(),
  slug: slug.optional(),
  description: z.string().trim().max(GROUP_DESCRIPTION_MAX).optional(),
  external_id: z.string().trim().min(1).max(255).nullable().optional(),
}).strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change');
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;

/** Adds members (a member already in the group takes the role sent). */
export const addGroupMembersSchema = z.object({
  member_ids: z.array(uuid('member_ids')).min(1, 'Name at least one member').max(GROUP_MEMBERS_BATCH_MAX, `At most ${GROUP_MEMBERS_BATCH_MAX} at a time`),
  role: z.enum(GROUP_ROLES).optional(),
}).strict();
export type AddGroupMembersInput = z.infer<typeof addGroupMembersSchema>;

export const updateGroupMemberSchema = z.object({ role: z.enum(GROUP_ROLES) }).strict();

/** A group as the API and the screens show it. */
export interface GroupView {
  id: string;
  name: string;
  slug: string;
  description: string;
  external_id: string | null;
  member_count: number;
  lead_count: number;
  /** Whether the reader is in it. */
  is_member: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** One member of a group. */
export interface GroupMemberView {
  member_id: string;
  name: string;
  avatar_url: string | null;
  title: string | null;
  /** The member's team role (owner, member, agent, ...). */
  team_role: string;
  status: 'active' | 'suspended';
  /** Their role in the group. */
  role: GroupRole;
  added_at: string;
}

/** A group as a target, where a person's name would read: "Finance (any member)". */
export function groupTargetLabel(name: string | null | undefined): string {
  return `${name?.trim() || 'A group'} (any member)`;
}
