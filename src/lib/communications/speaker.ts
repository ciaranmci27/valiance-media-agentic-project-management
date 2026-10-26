/**
 * Who is speaking in a message, worked out by the app so the agent never has
 * to guess it: the owner (Ciaran), a teammate, a client, a client's colleague,
 * a prospect, a machine, or a stranger. Also whether the inbox's agent was
 * addressed (its address among the main recipients, or its name at the top),
 * and whether a forward from the owner carries a note of his.
 *
 * - owner / teammate: the verified teammate behind the message
 *   (sender_member_id: an active person whose From passed DKIM), by role;
 * - machine: automated or bulk mail, or a notification or marketing sort;
 * - prospect: the sender is a live lead's email address;
 * - client: the sender maps to a project (a contact, client address or domain);
 * - client_colleague: anyone else on a conversation already filed on a project
 *   other than by a guess;
 * - stranger: everyone else.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { comms } from './db';
import { forwardNote } from './email/forwarded';
import type { Delivery, PolicyMessage, Speaker, Trust } from './triage-policy';

export interface MessageFacts extends PolicyMessage {
  fromAddress: string | null;
  senderMemberId: string | null;
}

type Row = Record<string, unknown>;

export async function messageFacts(supabase: SupabaseClient, messageId: string): Promise<MessageFacts> {
  const { data: message, error } = await comms(supabase).from('messages')
    .select('id, inbox_id, thread_id, subject, text_body, new_text, auth, kind, auto_mail_reason, delivery, sender_member_id, routing_basis')
    .eq('id', messageId).single();
  if (error) throw error;
  const row = message as Row;
  const [participants, inbox, candidates, filed] = await Promise.all([
    comms(supabase).from('participants').select('kind, address').eq('message_id', messageId),
    comms(supabase).from('inboxes').select('address, routing_address, aliases, handler_member_id').eq('id', row.inbox_id as string).single(),
    comms(supabase).from('message_candidates').select('project_id').eq('message_id', messageId).limit(1),
    comms(supabase).from('conversation_projects').select('source').eq('conversation_id', row.thread_id as string),
  ]);
  for (const result of [participants, inbox, candidates, filed]) if (result.error) throw result.error;
  const recipients = (participants.data ?? []) as { kind: string; address: string }[];
  const fromAddress = recipients.find((r) => r.kind === 'from')?.address ?? null;
  const box = inbox.data as { address: string; routing_address: string; aliases: string[] | null; handler_member_id: string | null };
  const senderMemberId = (row.sender_member_id as string | null) ?? null;

  const [members, leads] = await Promise.all([
    supabase.from('team_members').select('id, name, role').in('id', [senderMemberId, box.handler_member_id].filter(Boolean) as string[]),
    fromAddress
      ? supabase.from('leads').select('id').ilike('email', fromAddress).is('deleted_at', null).is('archived_at', null).limit(1)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (members.error) throw members.error;
  if (leads.error) throw leads.error;
  const memberById = new Map(((members.data ?? []) as { id: string; name: string; role: string }[]).map((m) => [m.id, m]));
  const sender = senderMemberId ? memberById.get(senderMemberId) ?? null : null;
  const agentName = box.handler_member_id ? (memberById.get(box.handler_member_id)?.name ?? '').split(/\s+/)[0] : '';

  const machine = !!row.auto_mail_reason || row.kind === 'notification' || row.kind === 'marketing';
  let speaker: Speaker;
  if (sender) speaker = sender.role === 'owner' ? 'owner' : 'teammate';
  else if (machine) speaker = 'machine';
  else if ((leads.data ?? []).length > 0) speaker = 'prospect';
  else if ((candidates.data ?? []).length > 0) speaker = 'client';
  else if (((filed.data ?? []) as { source: string }[]).some((p) => p.source !== 'guessed')) speaker = 'client_colleague';
  else speaker = 'stranger';

  const ours = new Set([box.address, box.routing_address, ...(box.aliases ?? [])].map((a) => a.toLowerCase()));
  const opening = ((row.new_text as string | null) ?? (row.text_body as string | null) ?? '').trim().slice(0, 200);
  const named = agentName.length > 1 && new RegExp(`^(hi |hey |hello )?${agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(opening);
  const addressedToAshley = recipients.some((r) => r.kind === 'to' && ours.has(r.address)) || named;

  const forwarded = row.routing_basis === 'forwarded_original';
  const note = forwarded ? forwardNote(row.subject as string | null, (row.text_body as string | null) ?? '') : null;
  return {
    speaker,
    trust: ((((row.auth ?? {}) as { trust?: string }).trust) ?? 'unknown') as Trust,
    delivery: (row.delivery as Delivery | null) ?? null,
    addressedToAshley,
    suspicious: false,
    ownerForwardWithoutNote: speaker === 'owner' && forwarded && (note ?? '').length < 3,
    fromAddress,
    senderMemberId,
  };
}
