'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, AtSign, Loader2, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Select, type SelectOption } from '@/components/ui/inputs/Select';
import { EMAIL_PAGES } from '@/components/settings/settings-groups';
import { AddressRow, addressLayout } from '@/components/settings/email/AddressRow';
import { AddressReview } from '@/components/settings/email/AddressReview';
import { YourDomains } from '@/components/settings/email/YourDomains';
import { EMAIL_PATTERN, NONE, domainOfAddress, errorMessage, focusAfterPaint, nextHop } from '@/components/settings/email/your-addresses';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { announceInboxChange, inboxSettingsClient } from '@/lib/communications/inbox-client';
import type {
  OwnDomain, UnlistedAddress, UnlistedDomain, YourAddress, YourAddressInput, YourAddressList, YourAddressPatchInput,
} from '@/lib/communications/inbox-types';

/**
 * Settings > Email > Your addresses: every address mail comes in on, with its
 * project (or none), whose it is (a person, or the company) and, with several
 * inboxes, which one it delivers to. Above the list, one folded line offers
 * addresses that got mail but nobody listed; below it, your domains.
 *
 * Changes are per row: a row shows its new value while it saves, goes back
 * if the server refuses, and never touches another row. Changing a project
 * asks first, since it can change where the forwarder must point. While a
 * row saves its controls keep focus but ignore input; when a row, a review
 * item or a form goes away, focus moves to the next sensible place.
 */

/** Past this many addresses a filter box shows above the list. */
const FILTER_AFTER = 10;

type Confirm =
  | { kind: 'project'; row: YourAddress; projectId: string | null }
  | { kind: 'inbox'; row: YourAddress; inboxId: string }
  | { kind: 'remove'; row: YourAddress };

interface AddForm {
  address: string;
  projectId: string;
  ownerId: string;
  inboxId: string;
}

export function YourAddressesSection() {
  const { isDemoMode } = useDemo();
  const { team, projects, emailsRefreshSignal } = useApp();
  const { teamMemberId } = useAuth();
  const client = useMemo(() => inboxSettingsClient(isDemoMode), [isDemoMode]);
  const headingId = useId();
  const addButtonId = useId();
  /** Each row's element, so focus can land on a row (or its neighbour) after a change. */
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const [data, setData] = useState<YourAddressList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  /** The scan for unlisted addresses: null while it runs (or if it failed). */
  const [review, setReview] = useState<UnlistedDomain[] | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  /** Rows saving, with the values they show meanwhile; plus review items and domains in flight. */
  const [pending, setPending] = useState<Record<string, YourAddressPatchInput>>({});
  const pendingRef = useRef(new Set<string>());
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  /** Rows that got a new relay address here, and when: they wait for mail through it. */
  const [relaySince, setRelaySince] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  /** The row the last question was about: focus returns to it if its control is gone. */
  const confirmRowId = useRef<string | null>(null);
  const [query, setQuery] = useState('');

  const [form, setForm] = useState<AddForm | null>(null);
  const [addressError, setAddressError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // ─── Load ───────────────────────────────────────────────────────────────────

  /** Bumped by every change made here, so a refresh that started before one never undoes it. */
  const changeSeq = useRef(0);

  /** Quiet loads (realtime refreshes) keep what is shown when they fail. Resolves to whether it loaded. */
  const load = useCallback(async (quiet = false): Promise<boolean> => {
    const started = changeSeq.current;
    try {
      const list = await client.yourAddresses();
      setData((prev) => (prev && changeSeq.current !== started
        ? { ...list, addresses: prev.addresses, domains: prev.domains }
        : list));
      setLoadError(null);
      return true;
    } catch (error) {
      if (!quiet) setLoadError(errorMessage(error, 'Could not load your addresses'));
      return false;
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // The review scan reads recent mail, so it runs once beside the first load,
  // again on Retry, and again when a domain stops being yours. Only the
  // latest scan's answer is kept.
  const scanSeq = useRef(0);
  const scan = useCallback(async () => {
    const seq = ++scanSeq.current;
    setReviewError(null);
    try {
      const list = await client.yourAddresses({ review: true });
      if (seq === scanSeq.current) setReview(list.unlisted);
    } catch (error) {
      if (seq === scanSeq.current) {
        setReview(null);
        setReviewError(errorMessage(error, 'Try again in a moment.'));
      }
    }
  }, [client]);

  useEffect(() => {
    void scan();
    // A scan still running when the page closes is ignored: the count moves past it.
    const seq = scanSeq;
    return () => { seq.current++; };
  }, [scan]);

  const firstSignal = useRef(emailsRefreshSignal);
  useEffect(() => {
    if (firstSignal.current === emailsRefreshSignal) return;
    void load(true);
  }, [emailsRefreshSignal, load]);

  /** Retry keeps focus while it runs; once the list is back, focus moves to the heading above it. */
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    const loaded = await load();
    setRetrying(false);
    if (loaded) focusSoon(() => document.getElementById(headingId));
  };

  // ─── Names and options ──────────────────────────────────────────────────────

  const projectName = useCallback(
    (id: string | null) => (id ? projects.find((p) => p.id === id)?.name ?? 'an unknown project' : 'no project'),
    [projects],
  );

  const projectOptions = useMemo<SelectOption[]>(() => {
    const live = projects.filter((p) => p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name));
    const listed = new Set(live.map((p) => p.id));
    // A project an address already names stays choosable, even when archived.
    const extra = [...new Set((data?.addresses ?? []).map((row) => row.project_id).filter((id): id is string => !!id && !listed.has(id)))]
      .map((id) => ({ value: id, label: projects.find((p) => p.id === id)?.name ?? 'Unknown project' }));
    return [{ value: NONE, label: 'No project' }, ...live.map((p) => ({ value: p.id, label: p.name })), ...extra];
  }, [projects, data]);

  const memberName = useCallback((id: string) => team.find((m) => m.id === id)?.name ?? 'Unknown member', [team]);

  /** "you", "your company" or a teammate's name, for sentences. */
  const ownerPhrase = useCallback(
    (id: string | null) => (!id ? 'your company' : id === teamMemberId ? 'you' : memberName(id)),
    [teamMemberId, memberName],
  );

  /** The choices for a new owner: you, each active teammate, the agents (labelled), then the company. */
  const ownerOptions = useMemo<SelectOption[]>(() => {
    const active = team.filter((m) => m.status !== 'suspended' && m.id !== teamMemberId).sort((a, b) => a.name.localeCompare(b.name));
    const people = active.filter((m) => m.role !== 'agent');
    const agents = active.filter((m) => m.role === 'agent');
    return [
      ...(teamMemberId ? [{ value: teamMemberId, label: 'You' }] : []),
      ...people.map((m) => ({ value: m.id, label: m.name })),
      ...agents.map((m) => ({ value: m.id, label: `${m.name} (agent)` })),
      { value: NONE, label: 'Company' },
    ];
  }, [team, teamMemberId]);

  /** A row's choices: the new-owner choices, plus the one it already names when that is not among them (suspended, say). */
  const ownerOptionsFor = useCallback((ownerId: string | null): SelectOption[] => {
    if (!ownerId || ownerOptions.some((option) => option.value === ownerId)) return ownerOptions;
    const member = team.find((m) => m.id === ownerId);
    const label = !member ? 'Unknown member' : member.status === 'suspended' ? `${member.name} (suspended)` : member.name;
    return [...ownerOptions.slice(0, -1), { value: ownerId, label }, ownerOptions[ownerOptions.length - 1]];
  }, [ownerOptions, team]);

  const inboxes = useMemo(() => data?.inboxes ?? [], [data]);
  const inboxById = useMemo(() => new Map(inboxes.map((inbox) => [inbox.id, inbox])), [inboxes]);
  const inboxOptions = useMemo<SelectOption[]>(
    () => inboxes.map((inbox) => ({ value: inbox.id, label: inbox.enabled ? inbox.name : `${inbox.name} (off)` })),
    [inboxes],
  );
  const defaultInboxId = (inboxes.find((inbox) => inbox.enabled) ?? inboxes[0])?.id ?? '';
  const showInbox = inboxes.length > 1;

  /** Who reads mail written to you, mid-sentence: the handler's name when there is one, else "the handler". */
  const handler = useMemo(() => {
    const live = inboxes.filter((inbox) => inbox.enabled);
    const ids = [...new Set((live.length ? live : inboxes).map((inbox) => inbox.handler_member_id))];
    const member = ids.length === 1 && ids[0] ? team.find((m) => m.id === ids[0]) : null;
    return member?.name ?? 'the handler';
  }, [inboxes, team]);

  // ─── Focus ──────────────────────────────────────────────────────────────────

  /** Focus after the next paint, once what it lands on is rendered; the heading when it is gone. */
  const focusSoon = (target: () => HTMLElement | null | undefined) =>
    focusAfterPaint(target, () => document.getElementById(headingId));

  // ─── Row changes ────────────────────────────────────────────────────────────

  const setBusy = (key: string, on: boolean) =>
    setBusyKeys((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const replaceRow = (row: YourAddress) =>
    setData((prev) => (prev ? { ...prev, addresses: prev.addresses.map((existing) => (existing.id === row.id ? row : existing)) } : prev));

  /** One change per row at a time; the row shows `patch` while it saves and its old value if refused. */
  const patchRow = async (row: YourAddress, patch: YourAddressPatchInput, success: (updated: YourAddress) => string): Promise<YourAddress | null> => {
    if (pendingRef.current.has(row.id)) return null;
    pendingRef.current.add(row.id);
    setPending((current) => ({ ...current, [row.id]: patch }));
    try {
      const updated = await client.updateYourAddress(row.id, patch);
      changeSeq.current++;
      replaceRow(updated);
      announceInboxChange();
      toast('success', success(updated));
      return updated;
    } catch (error) {
      toast('error', errorMessage(error, `Could not change ${row.address}`));
      return null;
    } finally {
      pendingRef.current.delete(row.id);
      setPending((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
    }
  };

  /** A row that is saving ignores input: its controls keep focus but take nothing. */
  const isSaving = (row: YourAddress) => pendingRef.current.has(row.id);

  const ask = (target: Confirm) => {
    confirmRowId.current = target.row.id;
    setConfirm(target);
  };

  const changeProject = (row: YourAddress, value: string) => {
    if (isSaving(row)) return;
    const projectId = value || null;
    if (projectId !== row.project_id) ask({ kind: 'project', row, projectId });
  };

  const saveProject = async (row: YourAddress, projectId: string | null) => {
    const updated = await patchRow(row, { project_id: projectId }, (saved) => {
      if (!saved.project_id) return `Mail to ${saved.address} is no longer filed on a project`;
      const fresh = saved.routing_address && saved.routing_address !== row.routing_address;
      return fresh
        ? `Mail to ${saved.address} goes to ${projectName(saved.project_id)}. Point its forwarder at ${saved.routing_address}.`
        : `Mail to ${saved.address} now goes to ${projectName(saved.project_id)}`;
    });
    if (updated?.routing_address && updated.routing_address !== row.routing_address) {
      const since = new Date().toISOString();
      setRelaySince((current) => ({ ...current, [row.id]: since }));
    }
  };

  const changeOwner = (row: YourAddress, value: string) => {
    if (isSaving(row)) return;
    const ownerId = value || null;
    if (ownerId === row.owner_member_id) return;
    void patchRow(row, { owner_member_id: ownerId }, (updated) => `Mail to ${updated.address} now reads as written to ${ownerPhrase(updated.owner_member_id)}`);
  };

  const changeInbox = (row: YourAddress, inboxId: string) => {
    if (isSaving(row) || !inboxId || inboxId === row.inbox_id) return;
    // Without a relay address of its own, its forwarder must point somewhere new.
    if (!row.routing_address) ask({ kind: 'inbox', row, inboxId });
    else void saveInbox(row, inboxId);
  };

  const saveInbox = (row: YourAddress, inboxId: string) =>
    patchRow(row, { inbox_id: inboxId }, (updated) => {
      const inbox = inboxById.get(updated.inbox_id);
      const hop = nextHop(updated, inbox);
      return !updated.routing_address && hop
        ? `${updated.address} delivers to ${inbox?.name ?? 'its inbox'}. Point its forwarder at ${hop}.`
        : `${updated.address} delivers to ${inbox?.name ?? 'its inbox'}`;
    });

  const toggle = (row: YourAddress) => {
    if (isSaving(row)) return;
    void patchRow(row, { enabled: !row.enabled }, (updated) => (updated.enabled ? `Turned on ${updated.address}` : `Turned off ${updated.address}. Mail to it is dropped.`));
  };

  const askRemove = (row: YourAddress) => {
    if (!isSaving(row)) ask({ kind: 'remove', row });
  };

  /** Removes the row; focus moves to the row after it in the list (or before it), else the heading. */
  const remove = async (row: YourAddress) => {
    if (pendingRef.current.has(row.id)) return;
    const at = visible.findIndex((existing) => existing.id === row.id);
    const neighbour = visible[at + 1] ?? visible[at - 1] ?? null;
    pendingRef.current.add(row.id);
    setPending((current) => ({ ...current, [row.id]: {} }));
    try {
      await client.removeYourAddress(row.id);
      changeSeq.current++;
      setData((prev) => (prev ? { ...prev, addresses: prev.addresses.filter((existing) => existing.id !== row.id) } : prev));
      announceInboxChange();
      toast('success', `Removed ${row.address}`);
      focusSoon(() => (neighbour ? rowRefs.current.get(neighbour.id) : null));
    } catch (error) {
      toast('error', errorMessage(error, `Could not remove ${row.address}`));
    } finally {
      pendingRef.current.delete(row.id);
      setPending((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
    }
  };

  // ─── Adding ─────────────────────────────────────────────────────────────────

  /** Adds the address, saying where to forward it; resolves to the new row, or the reason it could not be added. */
  const add = async (input: YourAddressInput): Promise<{ row: YourAddress } | { error: string }> => {
    try {
      const row = await client.addYourAddress(input);
      changeSeq.current++;
      setData((prev) => (prev ? { ...prev, addresses: [...prev.addresses, row] } : prev));
      announceInboxChange();
      const hop = nextHop(row, inboxById.get(row.inbox_id));
      toast('success', hop ? `Added ${row.address}. Forward it to ${hop} at your mail host.` : `Added ${row.address}`);
      return { row };
    } catch (error) {
      return { error: errorMessage(error, `Could not add ${input.address}`) };
    }
  };

  const openForm = () => {
    setForm({ address: '', projectId: NONE, ownerId: NONE, inboxId: defaultInboxId });
    setAddressError(undefined);
    setFormError(null);
  };

  /** Closes the form; focus goes to the row just added, else back to Add address. */
  const closeForm = (addedId: string | null = null) => {
    setForm(null);
    setAddressError(undefined);
    setFormError(null);
    focusSoon(() => (addedId ? rowRefs.current.get(addedId) : null) ?? document.getElementById(addButtonId));
  };

  const updateForm = <K extends keyof AddForm>(field: K, value: AddForm[K]) =>
    setForm((current) => (current ? { ...current, [field]: value } : current));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form || adding) return;
    const address = form.address.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(address)) {
      setAddressError('Enter the address in full, such as hello@yourdomain.com');
      return;
    }
    setAdding(true);
    const result = await add({
      address,
      project_id: form.projectId || null,
      owner_member_id: form.ownerId || null,
      ...(form.inboxId ? { inbox_id: form.inboxId } : {}),
    });
    setAdding(false);
    if ('error' in result) setFormError(result.error);
    else closeForm(result.row.id);
  };

  // ─── Review and domains ─────────────────────────────────────────────────────

  const dropFromReview = (address: string) =>
    setReview((current) => current?.map((group) => ({ ...group, addresses: group.addresses.filter((item) => item.address !== address) })) ?? current);

  /** Adds it to the inbox its latest mail arrived at (the default inbox if that one is gone). */
  const addUnlisted = async (item: UnlistedAddress): Promise<boolean> => {
    setBusy(item.address, true);
    const result = await add({
      address: item.address,
      project_id: null,
      owner_member_id: null,
      ...(inboxById.has(item.inbox_id) ? { inbox_id: item.inbox_id } : {}),
    });
    setBusy(item.address, false);
    if ('error' in result) toast('error', result.error);
    return 'row' in result;
  };

  const ignoreUnlisted = async (item: UnlistedAddress): Promise<boolean> => {
    setBusy(item.address, true);
    try {
      await client.ignoreAddress(item.address);
      dropFromReview(item.address);
      toast('success', `${item.address} won't be suggested again`);
      return true;
    } catch (error) {
      toast('error', errorMessage(error, `Could not hide ${item.address}`));
      return false;
    } finally {
      setBusy(item.address, false);
    }
  };

  /** Adds a domain of yours; resolves to null, or the reason it could not be added. */
  const addDomain = async (domain: string): Promise<string | null> => {
    setBusy(domain, true);
    try {
      const row = await client.addOwnDomain(domain);
      changeSeq.current++;
      setData((prev) => (prev ? { ...prev, domains: [...prev.domains, row].sort((a, b) => a.domain.localeCompare(b.domain)) } : prev));
      announceInboxChange();
      toast('success', `Every address on ${row.domain} now reads as written to you`);
      return null;
    } catch (error) {
      return errorMessage(error, `Could not add ${domain}`);
    } finally {
      setBusy(domain, false);
    }
  };

  const ownDomainFromReview = async (domain: string): Promise<boolean> => {
    const failure = await addDomain(domain);
    if (failure) toast('error', failure);
    return !failure;
  };

  /** Removes the domain, then scans again: its unlisted addresses can be suggested once more. */
  const removeDomain = async (domain: OwnDomain): Promise<boolean> => {
    setBusy(domain.id, true);
    try {
      await client.removeOwnDomain(domain.id);
      changeSeq.current++;
      setData((prev) => (prev ? { ...prev, domains: prev.domains.filter((row) => row.id !== domain.id) } : prev));
      announceInboxChange();
      toast('success', `Removed ${domain.domain}`);
      void scan();
      return true;
    } catch (error) {
      toast('error', errorMessage(error, `Could not remove ${domain.domain}`));
      return false;
    } finally {
      setBusy(domain.id, false);
    }
  };

  // ─── Derived ────────────────────────────────────────────────────────────────

  const addresses = useMemo(
    () => (data?.addresses ?? []).map((row) => (pending[row.id] ? { ...row, ...pending[row.id] } : row)),
    [data, pending],
  );

  /** What is left to review: not listed since, nor on a domain made yours since. */
  const toReview = useMemo(() => {
    if (!review || !data) return [];
    const listed = new Set(data.addresses.map((row) => row.address));
    const owned = new Set(data.domains.map((row) => row.domain));
    return review
      .filter((group) => !owned.has(group.domain))
      .map((group) => ({ ...group, addresses: group.addresses.filter((item) => !listed.has(item.address)) }))
      .filter((group) => group.addresses.length > 0);
  }, [review, data]);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!needle) return addresses;
    return addresses.filter((row) => {
      const inbox = inboxById.get(row.inbox_id);
      return [
        row.address,
        row.routing_address ?? '',
        row.project_id ? projectName(row.project_id) : '',
        row.owner_member_id ? memberName(row.owner_member_id) : 'company',
        inbox?.name ?? '',
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [addresses, needle, inboxById, projectName, memberName]);

  // ─── Confirm copy ───────────────────────────────────────────────────────────

  const confirmCopy = (target: Confirm): { title: string; message: string; label: string; danger: boolean } => {
    const { row } = target;
    if (target.kind === 'remove') {
      const domain = domainOfAddress(row.address);
      const domainIsYours = data?.domains.some((d) => d.domain === domain) ?? false;
      if (row.routing_address) {
        return {
          title: `Remove ${row.address}?`,
          message: `Mail forwarded to ${row.routing_address} will be dropped once it is gone, so point its forwarder somewhere else first. Mail already filed keeps its project. To pause it instead, turn it off.`,
          label: 'Remove',
          danger: true,
        };
      }
      return {
        title: `Remove ${row.address}?`,
        message: domainIsYours
          ? `Mail to it still reads as written to you, since ${domain} is one of your domains, but it no longer reads as written to ${ownerPhrase(row.owner_member_id)}. To stop its mail, turn off its forwarder at your mail host.`
          : `Mail to it will no longer read as written to ${ownerPhrase(row.owner_member_id)}, and it won't be suggested again. To stop its mail, turn off its forwarder at your mail host.`,
        label: 'Remove',
        danger: true,
      };
    }
    if (target.kind === 'inbox') {
      const inbox = inboxById.get(target.inboxId);
      const current = inboxById.get(row.inbox_id);
      return {
        title: `Deliver to ${inbox?.name ?? 'another inbox'}?`,
        message: `Point the forwarder for ${row.address} at ${inbox?.routing_address ?? 'its relay address'} at your mail host. Until you do, its mail keeps reaching ${current?.name ?? 'the inbox it reaches now'}.`,
        label: 'Change inbox',
        danger: false,
      };
    }
    const from = row.project_id;
    const to = target.projectId;
    if (!to) {
      return {
        title: `Take ${row.address} off ${projectName(from)}?`,
        message: `Mail to it keeps arriving through its relay address, but is no longer filed on ${projectName(from)}. Mail already filed stays there.`,
        label: 'Remove project',
        danger: false,
      };
    }
    if (!from && !row.routing_address) {
      return {
        title: `File its mail on ${projectName(to)}?`,
        message: `${row.address} gets a relay address of its own. Point its forwarder there at your mail host; until you do, its mail arrives unfiled. The new address shows on the row once saved.`,
        label: 'Give it a project',
        danger: false,
      };
    }
    return {
      title: `File its mail on ${projectName(to)}?`,
      message: from
        ? `Mail to ${row.address} will be filed on ${projectName(to)} instead of ${projectName(from)}. Mail already filed stays on ${projectName(from)}. Its forwarder stays as it is.`
        : `Mail to ${row.address} will be filed on ${projectName(to)} from now on. Its forwarder stays as it is.`,
      label: 'Change project',
      danger: false,
    };
  };

  const runConfirm = () => {
    const target = confirm;
    if (!target) return;
    if (target.kind === 'remove') void remove(target.row);
    else if (target.kind === 'inbox') void saveInbox(target.row, target.inboxId);
    else void saveProject(target.row, target.projectId);
  };

  const copy = confirm ? confirmCopy(confirm) : null;

  // ─── Render ─────────────────────────────────────────────────────────────────

  const canAdd = inboxes.length > 0;

  return (
    <section id="email-addresses" aria-labelledby={headingId} className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6">
      <SettingsSectionHeader
        icon={AtSign}
        title="Your addresses"
        headingId={headingId}
        focusableHeading
        description={`Mail sent to these reaches the app. Mail to one of yours reads as written to you: ${handler} treats it as a message addressed to you. Give one a project and its mail is filed there.`}
        action={data && !form && canAdd ? (
          <Button id={addButtonId} size="sm" className="flex-shrink-0 whitespace-nowrap" onClick={openForm} icon={<Plus size={14} aria-hidden="true" />}>
            <span className="sm:hidden">Add</span>
            <span className="hidden sm:inline">Add address</span>
          </Button>
        ) : null}
      />

      {!data && !loadError && (
        <div className="flex justify-center py-8">
          <Loader2 className="animate-spin motion-reduce:animate-none text-zinc-400" size={24} aria-label="Loading your addresses" role="status" />
        </div>
      )}

      {loadError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-3">
          <p className="flex items-start gap-2 text-sm text-red-300 min-w-0">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
            <span className="min-w-0">{loadError}</span>
          </p>
          <Button size="sm" variant="secondary" className="flex-shrink-0" onClick={() => void retry()} aria-disabled={retrying || undefined}>
            {retrying ? 'Retrying...' : 'Retry'}
          </Button>
        </div>
      )}

      {data && !canAdd && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-3">
          <p className="min-w-0 text-sm text-zinc-400">Addresses deliver to an inbox, and there is none yet.</p>
          <Button href={EMAIL_PAGES.handler} size="sm" variant="secondary" className="flex-shrink-0">Set up who handles your mail</Button>
        </div>
      )}

      {data && (
        <AddressReview
          groups={toReview}
          busy={busyKeys}
          canAdd={canAdd}
          scanError={reviewError}
          onRetryScan={() => void scan()}
          handler={handler}
          onAdd={addUnlisted}
          onIgnore={ignoreUnlisted}
          onOwnDomain={ownDomainFromReview}
          fallbackFocus={() => document.getElementById(headingId)}
        />
      )}

      {form && (
        <form
          onSubmit={submit}
          noValidate
          aria-label="New address"
          className="@container mb-6 p-4 bg-white/[0.03] border border-white/[0.08] rounded-lg space-y-4 animate-slideDown"
        >
          <h3 className="text-sm font-medium text-white">New address</h3>
          <TextInput
            label="Address"
            type="email"
            value={form.address}
            onChange={(value) => {
              updateForm('address', value);
              setAddressError(undefined);
              setFormError(null);
            }}
            placeholder="hello@yourdomain.com"
            description="What people write to"
            error={addressError}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            required
          />
          <div className={`grid grid-cols-1 gap-4 @lg:grid-cols-2 ${showInbox ? '@3xl:grid-cols-3' : ''}`}>
            <Select
              label="Project"
              visibleLabel="Project"
              value={form.projectId}
              onChange={(value) => updateForm('projectId', value)}
              options={projectOptions}
              searchable
              description="Optional. With one, its mail is filed there and it gets a relay address of its own."
            />
            <Select
              label="Whose"
              visibleLabel="Whose"
              value={form.ownerId}
              onChange={(value) => updateForm('ownerId', value)}
              options={ownerOptions}
              description="Who the mail is meant for"
            />
            {showInbox && (
              <Select
                label="Delivers to"
                visibleLabel="Delivers to"
                value={form.inboxId}
                onChange={(value) => updateForm('inboxId', value)}
                options={inboxOptions}
                description="The inbox whose handler reads its mail"
              />
            )}
          </div>
          {formError && <p role="alert" className="text-sm text-red-300">{formError}</p>}
          <div className="flex gap-2 pt-4 border-t border-white/[0.08]">
            <Button type="submit" disabled={adding}>{adding ? 'Adding...' : 'Add address'}</Button>
            <Button type="button" variant="secondary" onClick={() => closeForm()}>Cancel</Button>
          </div>
        </form>
      )}

      {/* Shown while it holds a search, so a filter is never left on out of sight. */}
      {data && (addresses.length > FILTER_AFTER || query !== '') && (
        <div className="mb-3 max-w-sm">
          <TextInput
            label="Find an address"
            type="search"
            value={query}
            onChange={setQuery}
            placeholder="Address, project or person"
            leftIcon={Search}
            size="sm"
            clearable
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}

      {data && addresses.length > 0 && (
        <p className="mb-3 text-xs text-zinc-400">
          <span className="font-medium text-zinc-200">Whose</span> is who the mail is meant for: you, a teammate, or the company.{' '}
          <span className="font-medium text-zinc-200">Forward it to</span> is the relay address your mail host forwards this address to.
        </p>
      )}

      {data && (addresses.length > 0 ? (
        // The list is its own container: columns only once it is wide enough for them.
        <div className="@container border border-white/[0.08] rounded-lg">
          <div
            className={`${addressLayout(showInbox).header} ${addressLayout(showInbox).grid} px-4 py-2 border-b border-white/[0.06] text-[11px] font-medium uppercase tracking-wide text-zinc-400`}
            aria-hidden="true"
          >
            <span>Address</span>
            <span>Project</span>
            <span>Whose</span>
            {showInbox && <span>Delivers to</span>}
            <span />
          </div>
          {visible.length > 0 ? (
            <ul className="divide-y divide-white/[0.06]" aria-label="Your addresses">
              {visible.map((row) => (
                <AddressRow
                  key={row.id}
                  row={row}
                  inbox={inboxById.get(row.inbox_id)}
                  showInbox={showInbox}
                  busy={!!pending[row.id]}
                  relaySince={relaySince[row.id] ?? null}
                  projectOptions={projectOptions}
                  ownerOptions={ownerOptionsFor(row.owner_member_id)}
                  inboxOptions={inboxOptions}
                  rowRef={(node) => {
                    if (node) rowRefs.current.set(row.id, node);
                    else rowRefs.current.delete(row.id);
                  }}
                  onProject={(value) => changeProject(row, value)}
                  onOwner={(value) => changeOwner(row, value)}
                  onInbox={(value) => changeInbox(row, value)}
                  onToggle={() => toggle(row)}
                  onRemove={() => askRemove(row)}
                />
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-center text-sm text-zinc-400" role="status">No address matches “{query.trim()}”.</p>
          )}
        </div>
      ) : !form ? (
        <div className="text-center py-6 text-zinc-400">
          <AtSign className="mx-auto mb-2" size={24} aria-hidden="true" />
          <p className="text-sm">No addresses yet</p>
          <p className="text-xs mt-1">Add the addresses people write to, such as hello@ or your own</p>
        </div>
      ) : null)}

      {data && (
        <YourDomains domains={data.domains} busy={busyKeys} onAdd={addDomain} onRemove={removeDomain} />
      )}

      <ConfirmDialog
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={runConfirm}
        returnFocus={() => (confirmRowId.current ? rowRefs.current.get(confirmRowId.current) : null) ?? document.getElementById(headingId)}
        title={copy?.title ?? ''}
        message={copy?.message ?? ''}
        confirmLabel={copy?.label ?? 'Confirm'}
        variant={copy?.danger ? 'danger' : 'default'}
        doubleConfirm={false}
      />
    </section>
  );
}
