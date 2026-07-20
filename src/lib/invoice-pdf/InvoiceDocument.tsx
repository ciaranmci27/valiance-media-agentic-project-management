'use client';

import { Document, Page, View, Text, Image, Link, StyleSheet } from '@react-pdf/renderer';
import type { InvoicePdfData } from './types';
import { registerInvoiceFonts } from './registerFonts';

registerInvoiceFonts();

// ── Color tokens (subset of globals.css palette, hardcoded as hex since
//    react-pdf can't read CSS variables) ──────────────────────────────
const COLOR = {
  ink: '#18181B',      // zinc-900 — headlines / strong text
  body: '#3F3F46',     // zinc-700 — body copy
  mute: '#71717A',     // zinc-500 — captions
  faint: '#A1A1AA',    // zinc-400 — micro labels
  hairline: '#E4E4E7', // zinc-200 — strong rules
  thin: '#F4F4F5',     // zinc-100 — table row separators
  surface: '#FAFAFA',  // zinc-50 — table header
  emerald: '#059669',
  amber: '#B45309',
  red: '#B91C1C',
  zincStamp: '#71717A',
};

const PAGE_MARGIN_X = 48;
const PAGE_MARGIN_TOP = 48;
const PAGE_MARGIN_BOTTOM = 56;

// ── Helpers ────────────────────────────────────────────────────────────
function formatMoney(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(yyyyMmDd: string | null | undefined): string {
  if (!yyyyMmDd) return '';
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  if (!y || !m || !d) return yyyyMmDd;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatGenerated(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatServicePeriod(start: string | null, end: string | null): string | null {
  if (!start && !end) return null;
  if (start && end && start !== end) return `${formatDate(start)} – ${formatDate(end)}`;
  return formatDate(start ?? end!);
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatDecimalHours(hours: number): string {
  const unit = Math.abs(hours - 1) < 0.000001 ? 'hr' : 'hrs';
  return `${hours.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${unit}`;
}

function statusPill(status: InvoicePdfData['status']): { label: string; color: string } {
  switch (status) {
    case 'paid':      return { label: 'Paid',      color: COLOR.emerald };
    case 'overdue':   return { label: 'Overdue',   color: COLOR.red };
    case 'cancelled': return { label: 'Cancelled', color: COLOR.zincStamp };
    case 'sent':      return { label: 'Sent',      color: COLOR.amber };
    case 'draft':     return { label: 'Draft',     color: COLOR.faint };
    default:          return { label: '',          color: COLOR.faint };
  }
}

function shouldStamp(status: InvoicePdfData['status']): { label: string; color: string } | null {
  switch (status) {
    case 'paid':      return { label: 'PAID',      color: COLOR.emerald };
    case 'overdue':   return { label: 'OVERDUE',   color: COLOR.red };
    case 'cancelled': return { label: 'CANCELLED', color: COLOR.zincStamp };
    default:          return null;
  }
}

// ── Document ───────────────────────────────────────────────────────────
export function InvoiceDocument({ data }: { data: InvoicePdfData }) {
  const styles = createStyles(data.brandColor);
  const stamp = shouldStamp(data.status);
  const pill = statusPill(data.status);
  const opts = data.options;

  return (
    <Document
      title={`Invoice ${data.invoiceNumber}`}
      author={data.business.name}
      subject={`Invoice ${data.invoiceNumber} for ${data.billTo.company || data.billTo.name || 'Client'}`}
    >
      <Page size="LETTER" style={styles.page}>
        {/* Top masthead accent bar (every page) */}
        {opts.showTopAccent && <View style={styles.topAccent} fixed />}

        {/* Diagonal status stamp (paid/overdue/cancelled only). Not `fixed`
            so it only stamps page 1 — the page with the actual invoice
            content. Repeating on every page would just clutter overflow
            pages that hold notes / portal callout. */}
        {stamp && opts.showStatusStamp && (
          <View style={[styles.stamp, { borderColor: stamp.color }]}>
            <Text style={[styles.stampText, { color: stamp.color }]}>{stamp.label}</Text>
          </View>
        )}

        {/* ── Header ──────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            {opts.showLogo && data.logoUrl ? (
              <Image src={data.logoUrl} style={styles.logo} />
            ) : (
              <Text style={styles.logoFallback}>{data.business.name}</Text>
            )}
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.eyebrow}>Invoice</Text>
            <Text style={styles.invoiceNumber}>{data.invoiceNumber}</Text>
          </View>
        </View>

        {/* ── Details strip (issue / due / terms / status) ────────── */}
        <View style={styles.detailsStrip}>
          <View style={styles.detailsCell}>
            <Text style={styles.detailsKey}>Issue Date</Text>
            <Text style={styles.detailsValue}>{formatDate(data.issueDate)}</Text>
          </View>
          <View style={styles.detailsCell}>
            <Text style={styles.detailsKey}>Due Date</Text>
            <Text style={styles.detailsValue}>{data.dueDate ? formatDate(data.dueDate) : '—'}</Text>
          </View>
          <View style={styles.detailsCell}>
            <Text style={styles.detailsKey}>Payment Terms</Text>
            <Text style={styles.detailsValue}>{data.paymentTerms}</Text>
          </View>
          <View style={styles.detailsCell}>
            <Text style={styles.detailsKey}>Status</Text>
            <View style={styles.statusPillRow}>
              <View style={[styles.statusDot, { backgroundColor: pill.color }]} />
              <Text style={[styles.detailsValue, { color: pill.color }]}>{pill.label}</Text>
            </View>
          </View>
        </View>

        {/* ── Parties (Billed To / From) ─────────────────────────── */}
        <View style={styles.parties}>
          <View style={styles.party}>
            <View style={styles.sectionLabel}>
              <View style={styles.sectionLabelDash} />
              <Text style={styles.sectionLabelText}>Billed To</Text>
            </View>
            {data.billTo.company ? (
              <Text style={styles.partyHeading}>{data.billTo.company}</Text>
            ) : data.billTo.name ? (
              <Text style={styles.partyHeading}>{data.billTo.name}</Text>
            ) : (
              <Text style={[styles.partyHeading, { color: COLOR.faint }]}>—</Text>
            )}
            {data.billTo.company && data.billTo.name ? (
              <Text style={styles.partyLine}>{data.billTo.name}</Text>
            ) : null}
            {data.billTo.address.split('\n').filter(Boolean).map((line, i) => (
              <Text key={i} style={styles.partyLine}>{line}</Text>
            ))}
            {data.billTo.email ? <Text style={styles.partyLine}>{data.billTo.email}</Text> : null}
          </View>

          <View style={styles.party}>
            <View style={styles.sectionLabel}>
              <View style={styles.sectionLabelDash} />
              <Text style={styles.sectionLabelText}>From</Text>
            </View>
            <Text style={styles.partyHeading}>{data.business.name}</Text>
            {opts.showSenderName && data.business.senderName ? (
              <Text style={styles.partyLine}>{data.business.senderName}</Text>
            ) : null}
            {data.business.address.split('\n').filter(Boolean).map((line, i) => (
              <Text key={i} style={styles.partyLine}>{line}</Text>
            ))}
            {data.business.email ? <Text style={styles.partyLine}>{data.business.email}</Text> : null}
            {data.business.phone ? <Text style={styles.partyLine}>{data.business.phone}</Text> : null}
          </View>
        </View>

        {/* ── Items table ────────────────────────────────────────── */}
        <View style={[styles.itemsHeading, styles.sectionLabel]}>
          <View style={styles.sectionLabelDash} />
          <Text style={styles.sectionLabelText}>Items</Text>
        </View>

        {/* Not `fixed` — `fixed` would repeat the header on every page,
            including pages that only contain post-items content (notes,
            portal callout) and would show a header with no rows beneath. */}
        <View style={styles.tableHeader}>
          <Text style={[styles.th, styles.colDescription]}>Description</Text>
          <Text style={[styles.th, styles.colQty]}>Qty</Text>
          <Text style={[styles.th, styles.colRate]}>Rate</Text>
          <Text style={[styles.th, styles.colAmount]}>Amount</Text>
        </View>

        {data.lineItems.map((li) => {
          const period = formatServicePeriod(li.service_start_date, li.service_end_date);
          const qtyText = li.quantity === null
            ? 'N/A'
            : li.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 });
          const rateText = li.rateLabel;
          const captionParts: string[] = [];
          if (li.item_type === 'recurring' && li.recurrence_frequency) {
            captionParts.push(`${li.recurrence_frequency.charAt(0).toUpperCase()}${li.recurrence_frequency.slice(1)}`);
          } else if (li.item_type !== 'fixed') {
            captionParts.push(`${li.item_type.charAt(0).toUpperCase()}${li.item_type.slice(1)}`);
          }
          if (period) captionParts.push(period);
          if (li.rateBreakdown.length > 1) {
            captionParts.push(li.rateBreakdown
              .map(rate => `${formatDecimalHours(rate.hours)} @ $${formatMoney(rate.hourlyRate)}`)
              .join(' + '));
          }
          const caption = captionParts.join(' · ');

          return (
            <View key={li.id} style={styles.tr} wrap={false}>
              <View style={styles.colDescription}>
                <Text style={styles.tdDescription}>
                  {li.description || (li.item_type === 'recurring'
                    ? 'Recurring charge'
                    : li.item_type === 'fixed'
                    ? 'Fixed charge'
                    : li.item_type === 'reimbursement'
                    ? 'Reimbursement'
                    : 'Hourly work')}
                </Text>
                {opts.showLineCaptions && caption ? <Text style={styles.tdCaption}>{caption}</Text> : null}
              </View>
              <Text style={[styles.tdMono, styles.colQty]}>{qtyText}</Text>
              <Text style={[styles.tdMono, styles.colRate]}>{rateText}</Text>
              <Text style={[styles.tdMono, styles.colAmount]}>${formatMoney(li.amount)}</Text>
            </View>
          );
        })}

        {/* ── Totals ─────────────────────────────────────────────── */}
        <View style={styles.totalsWrap}>
          <View style={styles.totalsBox}>
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>Subtotal</Text>
              <Text style={styles.totalsValue}>${formatMoney(data.subtotal)}</Text>
            </View>
            {data.taxRate != null && (
              <View style={styles.totalsRow}>
                <Text style={styles.totalsLabel}>Tax ({data.taxRate}%)</Text>
                <Text style={styles.totalsValue}>${formatMoney(data.taxAmount)}</Text>
              </View>
            )}
            <View style={styles.totalsAccent} />
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabelFinal}>Total Due</Text>
              <Text style={styles.totalsValueFinal}>${formatMoney(data.total)}</Text>
            </View>
          </View>
        </View>

        {/* ── Client Portal infotip card ─────────────────────────── */}
        {opts.showPortalLink && data.portalUrl && (
          <View style={styles.portalCallout} wrap={false}>
            <View style={styles.portalCalloutIcon}>
              <Text style={styles.portalCalloutIconText}>→</Text>
            </View>
            <View style={styles.portalCalloutContent}>
              <Text style={styles.portalCalloutTitle}>View this invoice in your client portal</Text>
              <Text style={styles.portalCalloutBody}>Track payment status, attachments, and project updates.</Text>
              <Link src={data.portalUrl}>
                <Text style={styles.portalCalloutLink}>{data.portalUrl}</Text>
              </Link>
            </View>
          </View>
        )}

        {/* ── Notes + Payment Instructions ──────────────────────── */}
        {((opts.showNotes && data.notes) || (opts.showPaymentInstructions && data.paymentInstructions)) && (
          <View style={styles.bottomBlocks} wrap={false}>
            {opts.showNotes && data.notes ? (
              <View style={styles.bottomCol}>
                <View style={styles.sectionLabel}>
                  <View style={styles.sectionLabelDash} />
                  <Text style={styles.sectionLabelText}>Notes</Text>
                </View>
                <Text style={styles.bottomBody}>{data.notes}</Text>
              </View>
            ) : <View style={styles.bottomCol} />}
            {opts.showPaymentInstructions && data.paymentInstructions ? (
              <View style={styles.bottomCol}>
                <View style={styles.sectionLabel}>
                  <View style={styles.sectionLabelDash} />
                  <Text style={styles.sectionLabelText}>Payment Instructions</Text>
                </View>
                <Text style={styles.bottomBody}>{data.paymentInstructions}</Text>
              </View>
            ) : <View style={styles.bottomCol} />}
          </View>
        )}

        {/* ── Footer ─────────────────────────────────────────────── */}
        {opts.showFooter && <View style={styles.footerRule} fixed />}
        {opts.showFooter && (
          <View style={styles.footer} fixed>
            <Text style={styles.footerText} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
            <Text style={[styles.footerText, { textAlign: 'center', flex: 1 }]}>{data.business.name}</Text>
            <Text style={styles.footerText}>Generated {formatGenerated(data.generatedAt)}</Text>
          </View>
        )}
      </Page>

      {/* ── Optional second page: time-entry log for hourly work ── */}
      {opts.showTimeLogs && data.timeLogEntries.length > 0 && (
        <TimeLogsPage data={data} styles={styles} />
      )}
    </Document>
  );
}

// ── Time logs page ─────────────────────────────────────────────────────
function TimeLogsPage({
  data,
  styles,
}: {
  data: InvoicePdfData;
  styles: ReturnType<typeof createStyles>;
}) {
  const opts = data.options;
  const entries = data.timeLogEntries;
  const totalHours = entries.reduce((sum, e) => sum + e.hours, 0);
  const totalAmount = entries.reduce((sum, e) => sum + e.amount, 0);
  const firstDay = entries[0]?.dayKey ?? null;
  const lastDay = entries[entries.length - 1]?.dayKey ?? null;
  const rangeLabel = firstDay && lastDay
    ? (firstDay === lastDay ? formatDate(firstDay) : `${formatDate(firstDay)} – ${formatDate(lastDay)}`)
    : '';
  // Member column only earns its keep when more than one person logged time.
  const uniqueMembers = new Set(entries.map(e => e.memberName).filter(Boolean));
  const showMember = uniqueMembers.size > 1;

  // Group entries by day so the date label only prints on the first row of
  // each day (rest collapse to keep the table scannable).
  const seenDay = new Set<string>();

  return (
    <Page size="LETTER" style={styles.page}>
      {opts.showTopAccent && <View style={styles.topAccent} fixed />}

      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.logoFallback}>{data.business.name}</Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.eyebrow}>Time Log</Text>
          <Text style={styles.invoiceNumber}>{data.invoiceNumber}</Text>
        </View>
      </View>

      <View style={styles.timeLogSummary}>
        <View style={styles.detailsCell}>
          <Text style={styles.detailsKey}>Period</Text>
          <Text style={styles.detailsValue}>{rangeLabel || '—'}</Text>
        </View>
        <View style={styles.detailsCell}>
          <Text style={styles.detailsKey}>Entries</Text>
          <Text style={styles.detailsValue}>{entries.length}</Text>
        </View>
        <View style={styles.detailsCell}>
          <Text style={styles.detailsKey}>Total Hours</Text>
          <Text style={styles.detailsValue}>
            {formatDecimalHours(totalHours)}
          </Text>
        </View>
      </View>

      <View style={[styles.itemsHeading, styles.sectionLabel]}>
        <View style={styles.sectionLabelDash} />
        <Text style={styles.sectionLabelText}>Time Entries</Text>
      </View>

      <View style={styles.tableHeader} fixed>
        <Text style={[styles.th, styles.tlColDate]}>Date</Text>
        <Text style={[styles.th, styles.tlColTime]}>Time</Text>
        <Text style={[styles.th, styles.tlColDescription]}>Description</Text>
        <Text style={[styles.th, styles.tlColDuration]}>Duration</Text>
        <Text style={[styles.th, styles.tlColAmount]}>Amount</Text>
      </View>

      {entries.map((entry) => {
        const isFirstOfDay = !seenDay.has(entry.dayKey);
        if (isFirstOfDay) seenDay.add(entry.dayKey);
        const timeRange = `${formatClock(entry.startIso)} – ${formatClock(entry.endIso)}`;

        return (
          <View key={entry.id} style={styles.tr} wrap={false}>
            <Text style={[styles.tdMono, styles.tlColDate]}>
              {isFirstOfDay ? formatDate(entry.dayKey) : ''}
            </Text>
            <Text style={[styles.tdMono, styles.tlColTime]}>{timeRange}</Text>
            <View style={styles.tlColDescription}>
              <Text style={styles.tdDescription}>
                {entry.description || <Text style={{ color: COLOR.faint }}>—</Text>}
              </Text>
              {showMember && entry.memberName ? (
                <Text style={styles.tdCaption}>{entry.memberName}</Text>
              ) : null}
            </View>
            <Text style={[styles.tdMono, styles.tlColDuration]}>{formatDecimalHours(entry.hours)}</Text>
            <Text style={[styles.tdMono, styles.tlColAmount]}>${formatMoney(entry.amount)}</Text>
          </View>
        );
      })}

      <View style={styles.timeLogTotalsWrap} wrap={false}>
        <View style={styles.timeLogTotalsBox}>
          <View style={styles.totalsAccent} />
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabelFinal}>Total Hours</Text>
            <Text style={styles.timeLogTotalValue}>
              {formatDecimalHours(totalHours)}
            </Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabelFinal}>Time Charges</Text>
            <Text style={styles.timeLogTotalValue}>${formatMoney(totalAmount)}</Text>
          </View>
        </View>
      </View>

      {opts.showFooter && <View style={styles.footerRule} fixed />}
      {opts.showFooter && (
        <View style={styles.footer} fixed>
          <Text style={styles.footerText} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
          <Text style={[styles.footerText, { textAlign: 'center', flex: 1 }]}>{data.business.name}</Text>
          <Text style={styles.footerText}>Generated {formatGenerated(data.generatedAt)}</Text>
        </View>
      )}
    </Page>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────
function createStyles(brandColor: string) {
  return StyleSheet.create({
    page: {
      paddingTop: PAGE_MARGIN_TOP,
      paddingBottom: PAGE_MARGIN_BOTTOM,
      paddingHorizontal: PAGE_MARGIN_X,
      fontFamily: 'DM Sans',
      fontSize: 9.5,
      color: COLOR.body,
      backgroundColor: '#FFFFFF',
    },

    // ── Top masthead bar (brand-colored, full content width) ─
    topAccent: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 5,
      backgroundColor: brandColor,
    },

    // ── Header ─────────────────────────────────
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: 40,
    },
    headerLeft: { flexDirection: 'row', alignItems: 'center' },
    headerRight: { alignItems: 'flex-end' },
    logo: { width: 120, height: 34, objectFit: 'contain' },
    logoFallback: { fontSize: 14, fontWeight: 700, color: COLOR.ink, letterSpacing: 0.4 },
    eyebrow: {
      fontSize: 8.5,
      fontWeight: 600,
      color: brandColor,
      letterSpacing: 2.4,
      textTransform: 'uppercase',
      marginBottom: 6,
    },
    invoiceNumber: {
      fontSize: 24,
      fontWeight: 700,
      color: COLOR.ink,
      letterSpacing: 0.3,
    },

    // ── Parties (Billed To / From) ─────────────
    parties: {
      flexDirection: 'row',
      gap: 36,
      marginBottom: 28,
    },
    party: { flex: 1 },
    sectionLabel: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 10,
    },
    sectionLabelDash: {
      width: 14,
      height: 1,
      backgroundColor: brandColor,
      marginRight: 8,
    },
    sectionLabelText: {
      fontSize: 7.5,
      fontWeight: 600,
      letterSpacing: 1.6,
      textTransform: 'uppercase',
      color: COLOR.mute,
    },
    partyHeading: { fontSize: 11, fontWeight: 600, color: COLOR.ink, marginBottom: 4, letterSpacing: 0.1 },
    partyLine: { fontSize: 9.5, color: COLOR.body, marginBottom: 1.5, lineHeight: 1.4 },

    // ── Details strip ──────────────────────────
    detailsStrip: {
      flexDirection: 'row',
      borderTopWidth: 0.5,
      borderTopColor: COLOR.hairline,
      borderBottomWidth: 0.5,
      borderBottomColor: COLOR.hairline,
      paddingVertical: 12,
      marginBottom: 32,
    },
    detailsCell: { flex: 1, paddingHorizontal: 4 },
    detailsKey: {
      fontSize: 7.5,
      fontWeight: 500,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      color: COLOR.faint,
      marginBottom: 5,
    },
    detailsValue: { fontSize: 10, color: COLOR.ink, fontWeight: 500 },
    statusPillRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    statusDot: { width: 6, height: 6, borderRadius: 3 },

    // ── Items table ────────────────────────────
    itemsHeading: { marginBottom: 8 },
    tableHeader: {
      flexDirection: 'row',
      backgroundColor: brandColor + '0F', // ~6% opacity tint
      borderTopWidth: 1,
      borderTopColor: brandColor,
      borderBottomWidth: 0.5,
      borderBottomColor: COLOR.hairline,
      paddingVertical: 9,
      paddingHorizontal: 10,
    },
    th: {
      fontSize: 7.5,
      color: brandColor,
      fontWeight: 600,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
    },
    tr: {
      flexDirection: 'row',
      paddingVertical: 12,
      paddingHorizontal: 10,
      alignItems: 'flex-start',
      borderBottomWidth: 0.5,
      borderBottomColor: COLOR.thin,
    },
    colDescription: { flex: 1, paddingRight: 12 },
    colQty: { width: 50, textAlign: 'right' },
    colRate: { width: 80, textAlign: 'right' },
    colAmount: { width: 90, textAlign: 'right' },
    tdDescription: { fontSize: 10, color: COLOR.ink, lineHeight: 1.4, fontWeight: 500 },
    tdCaption: { fontSize: 8.5, color: COLOR.mute, marginTop: 3, lineHeight: 1.3 },
    tdMono: { fontSize: 10, color: COLOR.ink },

    // ── Totals ─────────────────────────────────
    totalsWrap: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 22 },
    totalsBox: { width: 260 },
    totalsRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 5,
    },
    totalsAccent: {
      height: 1,
      backgroundColor: brandColor,
      marginVertical: 6,
    },
    totalsLabel: { fontSize: 9.5, color: COLOR.mute },
    totalsValue: { fontSize: 9.5, color: COLOR.body },
    totalsLabelFinal: { fontSize: 12, color: COLOR.ink, fontWeight: 700, letterSpacing: 0.2 },
    totalsValueFinal: {
      fontSize: 20,
      color: brandColor,
      fontWeight: 700,
      letterSpacing: 0.2,
    },

    // ── Portal infotip card ────────────────────
    portalCallout: {
      marginTop: 22,
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingVertical: 11,
      paddingHorizontal: 14,
      backgroundColor: brandColor + '14', // ~8% tint
      borderRadius: 6,
    },
    portalCalloutIcon: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: brandColor,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 10,
      marginTop: 1,
    },
    portalCalloutIconText: {
      fontSize: 11,
      color: '#FFFFFF',
      fontWeight: 700,
      lineHeight: 1,
      marginTop: -1,
    },
    portalCalloutContent: { flex: 1 },
    portalCalloutTitle: {
      fontSize: 10,
      fontWeight: 700,
      color: COLOR.ink,
      marginBottom: 2,
    },
    portalCalloutBody: {
      fontSize: 8.5,
      color: COLOR.body,
      lineHeight: 1.35,
      marginBottom: 4,
    },
    portalCalloutLink: {
      fontSize: 9,
      color: brandColor,
      fontWeight: 500,
      textDecoration: 'underline',
    },

    // ── Notes & Instructions ───────────────────
    bottomBlocks: {
      flexDirection: 'row',
      gap: 36,
      marginTop: 36,
      paddingTop: 18,
      borderTopWidth: 0.5,
      borderTopColor: COLOR.hairline,
    },
    bottomCol: { flex: 1 },
    bottomBody: { fontSize: 9, color: COLOR.body, lineHeight: 1.55 },

    // ── Footer ─────────────────────────────────
    footerRule: {
      position: 'absolute',
      bottom: 38,
      left: PAGE_MARGIN_X,
      right: PAGE_MARGIN_X,
      height: 0.5,
      backgroundColor: COLOR.hairline,
    },
    footer: {
      position: 'absolute',
      bottom: 22,
      left: PAGE_MARGIN_X,
      right: PAGE_MARGIN_X,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    footerText: { fontSize: 7.5, color: COLOR.faint, letterSpacing: 0.6 },

    // ── Status stamp ───────────────────────────
    stamp: {
      position: 'absolute',
      top: 150,
      right: 80,
      paddingVertical: 6,
      paddingHorizontal: 14,
      borderWidth: 1.5,
      borderRadius: 3,
      transform: 'rotate(-6deg)',
      opacity: 0.22,
    },
    stampText: {
      fontSize: 18,
      fontWeight: 700,
      letterSpacing: 4,
    },

    // ── Time logs page ─────────────────────────
    timeLogSummary: {
      flexDirection: 'row',
      borderTopWidth: 0.5,
      borderTopColor: COLOR.hairline,
      borderBottomWidth: 0.5,
      borderBottomColor: COLOR.hairline,
      paddingVertical: 12,
      marginBottom: 32,
    },
    tlColDate:        { width: 75, paddingRight: 8 },
    tlColTime:        { width: 115, paddingRight: 8 },
    tlColDescription: { flex: 1, paddingRight: 10 },
    tlColDuration:    { width: 64, paddingRight: 10, textAlign: 'right' },
    tlColAmount:      { width: 72, textAlign: 'right' },
    timeLogTotalsWrap: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 22 },
    timeLogTotalsBox: { width: 200 },
    timeLogTotalValue: {
      fontSize: 16,
      color: brandColor,
      fontWeight: 700,
      letterSpacing: 0.2,
    },
  });
}
