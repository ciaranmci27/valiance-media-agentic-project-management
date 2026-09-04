import {
  Document,
  Page,
  View,
  Text,
  Image,
  Link,
  StyleSheet,
  Svg,
  Defs,
  LinearGradient,
  Stop,
  Rect,
} from '@react-pdf/renderer';
import type { InvoiceStatus } from '@/lib/types';
import { EMAIL, accentPalette } from '@/lib/email/templates/shared';
import type { InvoicePdfData, InvoicePdfTheme } from './types';
import {
  INVOICE_FONT_FAMILY,
  INVOICE_FONT_MONO,
  INVOICE_FONT_SERIF,
  registerInvoiceFonts,
} from './registerFonts';

registerInvoiceFonts();

/**
 * The brand's design language on two canvases, laid out the way the invoice
 * email is: the lockup, one headline with a serif tail, a mono line of facts,
 * then the amount on a glass tile with the status chip, and mono captions on
 * hairlines for everything tabular.
 *
 * `dark` is the brand's own: the near-black canvas the website, the portal
 * and the emails sit on. Its values come straight from the email palette so
 * the PDF and the mail it travels with are one thing. `paper` is the same
 * layout on white for anyone who prints or files a copy; there the teal steps
 * down to the brand's 600 and 700 (brand 500 is only 3.6:1 on white) and the
 * copper deepens for the same reason. Hex only: react-pdf cannot read CSS
 * variables.
 */
interface Palette {
  page: string;
  /** Tinted surfaces: the amount tile, the stat tiles. */
  tile: string;
  /** The lighter top edge of a tile, the glass rim. */
  tileRim: string;
  ink: string;
  body: string;
  muted: string;
  hairline: string;
  hairlineStrong: string;
  row: string;
  /** Teal for the totals rule, URLs and chip text. */
  accent: string;
  accentTile: string;
  accentBorder: string;
  /** The serif tail and copper chip text. */
  copper: string;
  copperTile: string;
  copperBorder: string;
  rose: string;
  roseTile: string;
  roseBorder: string;
  /** A neutral chip has to stand off the tile it sits on. */
  chipNeutralTile: string;
  chipNeutralBorder: string;
  stampOpacity: number;
}

const PAPER: Palette = {
  page: '#FFFFFF',
  tile: '#F5F3EF',
  tileRim: '#E6E4DF',
  ink: '#0D0F14',
  body: '#3F4046',
  muted: '#6E6D69',
  hairline: '#E6E4DF',
  hairlineStrong: '#D9D6CF',
  row: '#EFEDE8',
  accent: '#4A7171',
  accentTile: '#F0F5F5',
  accentBorder: '#D9E6E6',
  copper: '#8F7159',
  copperTile: '#F3EDE9',
  copperBorder: '#E2D2C7',
  rose: '#A33F3F',
  roseTile: '#F8ECEC',
  roseBorder: '#E6C6C6',
  chipNeutralTile: '#FFFFFF',
  chipNeutralBorder: '#D9D6CF',
  stampOpacity: 0.28,
};

function paletteFor(theme: InvoicePdfTheme): Palette {
  if (theme === 'paper') return PAPER;
  const teal = accentPalette();
  return {
    page: EMAIL.canvas,
    tile: EMAIL.tile,
    tileRim: EMAIL.borderStrong,
    ink: EMAIL.ink,
    body: EMAIL.body,
    muted: EMAIL.muted,
    hairline: EMAIL.border,
    hairlineStrong: EMAIL.borderStrong,
    row: EMAIL.border,
    accent: teal.bright,
    accentTile: teal.tile,
    accentBorder: teal.border,
    copper: EMAIL.copper300,
    copperTile: EMAIL.copperTile,
    copperBorder: EMAIL.copperBorder,
    rose: EMAIL.error,
    roseTile: EMAIL.errorTile,
    roseBorder: EMAIL.errorBorder,
    chipNeutralTile: EMAIL.border,
    chipNeutralBorder: EMAIL.borderStrong,
    stampOpacity: 0.55,
  };
}

// The website button: the same teal gradient on either canvas, dark text.
const BUTTON = { top: '#A3C4C4', bottom: '#5B8A8A', text: '#08090C', width: 100, height: 26 };

type Tone = 'teal' | 'copper' | 'rose' | 'neutral';
type Tones = Record<Tone, { text: string; tile: string; border: string }>;

function tonesFor(p: Palette): Tones {
  return {
    teal: { text: p.accent, tile: p.accentTile, border: p.accentBorder },
    copper: { text: p.copper, tile: p.copperTile, border: p.copperBorder },
    rose: { text: p.rose, tile: p.roseTile, border: p.roseBorder },
    neutral: { text: p.muted, tile: p.chipNeutralTile, border: p.chipNeutralBorder },
  };
}

/**
 * How each status presents, mirroring the invoice email (statusDetails in
 * lib/email/templates/client/invoice.ts) so the PDF and the mail it travels
 * with say the same thing. Only the statuses with `stamp` get the diagonal
 * stamp, in their tone's colour.
 */
const STATUS: Record<InvoiceStatus, {
  amountLabel: string;
  title: string;
  tail: string;
  chip: string;
  tone: Tone;
  stamp?: boolean;
}> = {
  draft: { amountLabel: 'Draft total', title: 'Draft invoice for', tail: 'review.', chip: 'Draft', tone: 'neutral' },
  sent: { amountLabel: 'Amount due', title: 'Your invoice is', tail: 'ready.', chip: 'Sent', tone: 'teal' },
  paid: { amountLabel: 'Amount paid', title: 'Payment', tail: 'received.', chip: 'Paid', tone: 'teal', stamp: true },
  overdue: { amountLabel: 'Past due', title: 'This invoice is', tail: 'past due.', chip: 'Overdue', tone: 'copper', stamp: true },
  cancelled: { amountLabel: 'Cancelled total', title: 'Invoice', tail: 'cancelled.', chip: 'Cancelled', tone: 'rose', stamp: true },
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

/** "Mar 15 – Apr 14, 2026" when both dates share a year, else both in full. */
function formatRange(start: string, end: string): string {
  if (start === end) return formatDate(start);
  if (start.slice(0, 4) === end.slice(0, 4)) {
    const [y, m, d] = start.split('-').map(Number);
    const short = y && m && d
      ? new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : formatDate(start);
    return `${short} – ${formatDate(end)}`;
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
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

type Styles = ReturnType<typeof createStyles>;

/** Everything a page section needs to draw itself. */
interface Kit {
  data: InvoicePdfData;
  styles: Styles;
  tones: Tones;
  logoSrc: string;
}

// ── Shared pieces ──────────────────────────────────────────────────────

/** A status as a pill in the mono caption style. */
function Chip({ label, tone, kit }: { label: string; tone: Tone; kit: Kit }) {
  const c = kit.tones[tone];
  return (
    <View style={[kit.styles.chip, { backgroundColor: c.tile, borderColor: c.border }]}>
      <Text style={[kit.styles.chipText, { color: c.text }]}>{label}</Text>
    </View>
  );
}

/** The lockup on the left; the document's name and number, small, on the right. */
function Masthead({ eyebrow, kit }: { eyebrow: string; kit: Kit }) {
  const { data, styles, logoSrc } = kit;
  return (
    <View style={styles.masthead}>
      {data.options.showLogo && logoSrc ? (
        // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf's Image has no alt prop
        <Image src={logoSrc} style={styles.logo} />
      ) : (
        <Text style={styles.logoFallback}>{data.business.name}</Text>
      )}
      <View style={styles.mastheadRight}>
        <Text style={styles.monoLabel}>{eyebrow}</Text>
        <Text style={styles.docNumber}>{data.invoiceNumber}</Text>
      </View>
    </View>
  );
}

/** The one display line on a page: sans with the serif italic tail, and an optional mono line of facts under it. */
function Heading({ title, tail, meta, kit }: { title: string; tail: string; meta?: string; kit: Kit }) {
  const { styles } = kit;
  return (
    <View style={styles.headingBlock}>
      <Text style={styles.heading}>
        {title}{' '}
        <Text style={styles.headingTail}>{tail}</Text>
      </Text>
      {meta ? <Text style={styles.meta}>{meta}</Text> : null}
    </View>
  );
}

/** The website button as a PDF: gradient pill, dark text, an arrow. */
function PillLink({ href, label, kit }: { href: string; label: string; kit: Kit }) {
  const { styles } = kit;
  return (
    <Link src={href} style={styles.plainLink}>
      <View style={styles.pill}>
        <Svg style={styles.pillBg} width={BUTTON.width} height={BUTTON.height} viewBox={`0 0 ${BUTTON.width} ${BUTTON.height}`}>
          <Defs>
            <LinearGradient id="pill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={BUTTON.top} />
              <Stop offset="1" stopColor={BUTTON.bottom} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={BUTTON.width} height={BUTTON.height} rx={BUTTON.height / 2} ry={BUTTON.height / 2} fill="url(#pill)" />
        </Svg>
        <Text style={styles.pillText}>{label}</Text>
        <Text style={styles.pillText}>→</Text>
      </View>
    </Link>
  );
}

/** Page x / y, the business, and when the document was generated. */
function Footer({ kit }: { kit: Kit }) {
  const { data, styles } = kit;
  if (!data.options.showFooter) return null;
  return (
    <>
      <View style={styles.footerRule} fixed />
      <View style={styles.footer} fixed>
        <Text style={styles.footerText} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        <Text style={[styles.footerText, styles.footerCenter]}>{data.business.name}</Text>
        <Text style={styles.footerText}>Generated {formatGenerated(data.generatedAt)}</Text>
      </View>
    </>
  );
}

// ── Document ───────────────────────────────────────────────────────────
export function InvoiceDocument({ data, theme = 'dark' }: { data: InvoicePdfData; theme?: InvoicePdfTheme }) {
  const palette = paletteFor(theme);
  const styles = createStyles(palette);
  const tones = tonesFor(palette);
  const logoSrc = theme === 'dark' ? (data.logoDarkUrl ?? data.logoUrl) : data.logoUrl;
  const kit: Kit = { data, styles, tones, logoSrc };
  const status = STATUS[data.status] ?? STATUS.sent;
  const stampColor = status.stamp ? tones[status.tone].text : null;
  const opts = data.options;

  // One mono line of facts under the headline, the way the emails do it.
  const meta = [
    `Issued ${formatDate(data.issueDate)}`,
    data.dueDate ? `Due ${formatDate(data.dueDate)}` : null,
    data.status === 'paid' && data.paidDate ? `Paid ${formatDate(data.paidDate)}` : null,
    `Terms ${data.paymentTerms}`,
  ].filter(Boolean).join('  ·  ');

  return (
    <Document
      title={`Invoice ${data.invoiceNumber}`}
      author={data.business.name}
      subject={`Invoice ${data.invoiceNumber} for ${data.billTo.company || data.billTo.name || 'Client'}`}
    >
      <Page size="LETTER" style={styles.page}>
        <Masthead eyebrow="Invoice" kit={kit} />

        <Heading title={status.title} tail={status.tail} meta={meta} kit={kit} />

        {/* ── The amount on a glass tile, the status beside it ───────── */}
        <View style={styles.hero} wrap={false}>
          <View style={styles.heroTop}>
            <View>
              <Text style={[styles.monoLabel, styles.heroLabel]}>{status.amountLabel}</Text>
              <Text style={styles.heroAmount}>${formatMoney(data.total)}</Text>
            </View>
            <Chip label={status.chip} tone={status.tone} kit={kit} />
          </View>
          {/* Diagonal status stamp (paid / overdue / cancelled) in the tile's
              empty right half, drawn after the fill so it sits on top. */}
          {opts.showStatusStamp && stampColor && (
            <View style={[styles.stamp, { borderColor: stampColor }]}>
              <Text style={[styles.stampText, { color: stampColor }]}>{status.chip}</Text>
            </View>
          )}
        </View>

        {/* ── Parties ─────────────────────────────────────────────── */}
        <View style={styles.parties}>
          <View style={styles.party}>
            <Text style={[styles.monoLabel, styles.sectionLabel]}>Billed to</Text>
            {data.billTo.company ? (
              <Text style={styles.partyHeading}>{data.billTo.company}</Text>
            ) : data.billTo.name ? (
              <Text style={styles.partyHeading}>{data.billTo.name}</Text>
            ) : (
              <Text style={[styles.partyHeading, { color: palette.muted }]}>-</Text>
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
            <Text style={[styles.monoLabel, styles.sectionLabel]}>From</Text>
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

        {/* ── Items: mono captions on a hairline, rows on hairlines ── */}
        {/* Not `fixed`: `fixed` would repeat the header on every page,
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
              <Text style={[styles.tdMono, styles.colRate]}>{li.rateLabel}</Text>
              <Text style={[styles.tdMono, styles.colAmount]}>${formatMoney(li.amount)}</Text>
            </View>
          );
        })}

        {/* ── Totals ──────────────────────────────────────────────── */}
        <View style={styles.totalsWrap} wrap={false}>
          <View style={styles.totalsBox}>
            <View style={styles.totalsRow}>
              <Text style={styles.monoLabel}>Subtotal</Text>
              <Text style={styles.totalsValue}>${formatMoney(data.subtotal)}</Text>
            </View>
            {data.taxRate != null && (
              <View style={[styles.totalsRow, styles.totalsRowNext]}>
                <Text style={styles.monoLabel}>Tax ({data.taxRate}%)</Text>
                <Text style={styles.totalsValue}>${formatMoney(data.taxAmount)}</Text>
              </View>
            )}
            <View style={styles.totalsRule} />
            <View style={styles.totalsFinal}>
              <Text style={styles.totalsFinalLabel}>{status.amountLabel}</Text>
              <Text style={styles.totalsFinalValue}>${formatMoney(data.total)}</Text>
            </View>
          </View>
        </View>

        {/* ── Client portal ───────────────────────────────────────── */}
        {opts.showPortalLink && data.portalUrl && (
          <View style={styles.callout} wrap={false}>
            <View style={styles.calloutText}>
              <Text style={styles.calloutTitle}>View this invoice in your client portal</Text>
              <Text style={styles.calloutBody}>Track payment status, attachments and project updates.</Text>
              {/* react-pdf gives every Link a blue underline by default; each one here sets its own look. */}
              <Link src={data.portalUrl} style={styles.plainLink}>
                <Text style={styles.calloutUrl}>{data.portalUrl}</Text>
              </Link>
            </View>
            <PillLink href={data.portalUrl} label="Open portal" kit={kit} />
          </View>
        )}

        {/* ── Notes and payment instructions ──────────────────────── */}
        {((opts.showNotes && data.notes) || (opts.showPaymentInstructions && data.paymentInstructions)) && (
          <View style={styles.bottomBlocks} wrap={false}>
            {opts.showNotes && data.notes ? (
              <View style={styles.bottomCol}>
                <Text style={[styles.monoLabel, styles.sectionLabel]}>Notes</Text>
                <Text style={styles.bottomBody}>{data.notes}</Text>
              </View>
            ) : <View style={styles.bottomCol} />}
            {opts.showPaymentInstructions && data.paymentInstructions ? (
              <View style={styles.bottomCol}>
                <Text style={[styles.monoLabel, styles.sectionLabel]}>Payment instructions</Text>
                <Text style={styles.bottomBody}>{data.paymentInstructions}</Text>
              </View>
            ) : <View style={styles.bottomCol} />}
          </View>
        )}

        <Footer kit={kit} />
      </Page>

      {/* ── Optional second page: time-entry log for hourly work ── */}
      {opts.showTimeLogs && data.timeLogEntries.length > 0 && (
        <TimeLogsPage kit={kit} palette={palette} />
      )}
    </Document>
  );
}

// ── Time logs page ─────────────────────────────────────────────────────
function TimeLogsPage({ kit, palette }: { kit: Kit; palette: Palette }) {
  const { data, styles } = kit;
  const entries = data.timeLogEntries;
  const totalHours = entries.reduce((sum, e) => sum + e.hours, 0);
  const totalAmount = entries.reduce((sum, e) => sum + e.amount, 0);
  const firstDay = entries[0]?.dayKey ?? null;
  const lastDay = entries[entries.length - 1]?.dayKey ?? null;
  const rangeLabel = firstDay && lastDay ? formatRange(firstDay, lastDay) : '';
  // Member column only earns its keep when more than one person logged time.
  const uniqueMembers = new Set(entries.map(e => e.memberName).filter(Boolean));
  const showMember = uniqueMembers.size > 1;

  // Group entries by day so the date label only prints on the first row of
  // each day (rest collapse to keep the table scannable).
  const seenDay = new Set<string>();

  return (
    <Page size="LETTER" style={styles.page}>
      <Masthead eyebrow="Time log" kit={kit} />

      <Heading title="Time" tail="logged." kit={kit} />

      {/* Three figures at a glance, the email's stat grid. */}
      <View style={styles.statRow}>
        <View style={[styles.statTile, styles.statTileWide]}>
          <Text style={[styles.monoLabel, styles.statLabel]}>Period</Text>
          <Text style={styles.statValue}>{rangeLabel || '–'}</Text>
        </View>
        <View style={styles.statTile}>
          <Text style={[styles.monoLabel, styles.statLabel]}>Entries</Text>
          <Text style={styles.statValue}>{entries.length}</Text>
        </View>
        <View style={styles.statTile}>
          <Text style={[styles.monoLabel, styles.statLabel]}>Total hours</Text>
          <Text style={styles.statValue}>{formatDecimalHours(totalHours)}</Text>
        </View>
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
                {entry.description || <Text style={{ color: palette.muted }}>-</Text>}
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

      <View style={styles.totalsWrap} wrap={false}>
        <View style={styles.totalsBox}>
          <View style={styles.totalsRule} />
          <View style={styles.totalsFinal}>
            <Text style={styles.totalsFinalLabel}>Total hours</Text>
            <Text style={styles.timeLogTotalValue}>{formatDecimalHours(totalHours)}</Text>
          </View>
          <View style={styles.totalsFinal}>
            <Text style={styles.totalsFinalLabel}>Time charges</Text>
            <Text style={styles.timeLogTotalValue}>${formatMoney(totalAmount)}</Text>
          </View>
        </View>
      </View>

      <Footer kit={kit} />
    </Page>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────
function createStyles(p: Palette) {
  return StyleSheet.create({
    page: {
      paddingTop: PAGE_MARGIN_TOP,
      paddingBottom: PAGE_MARGIN_BOTTOM,
      paddingHorizontal: PAGE_MARGIN_X,
      fontFamily: INVOICE_FONT_FAMILY,
      fontSize: 9.5,
      color: p.body,
      backgroundColor: p.page,
    },

    // ── Type ───────────────────────────────────
    // Small mono caption for data: field names, table heads, footer.
    monoLabel: {
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 7,
      fontWeight: 400,
      letterSpacing: 1,
      textTransform: 'uppercase',
      color: p.muted,
    },
    sectionLabel: { marginBottom: 9 },

    // ── Masthead ───────────────────────────────
    masthead: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: 34,
    },
    logo: { width: 120, height: 34, objectFit: 'contain' },
    logoFallback: { fontSize: 13, fontWeight: 600, color: p.ink, letterSpacing: -0.2 },
    mastheadRight: { alignItems: 'flex-end' },
    docNumber: {
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 10.5,
      fontWeight: 400,
      color: p.ink,
      marginTop: 5,
    },

    // ── Heading ────────────────────────────────
    headingBlock: { marginBottom: 20 },
    heading: {
      fontSize: 25,
      fontWeight: 500,
      letterSpacing: -0.6,
      lineHeight: 1.1,
      color: p.ink,
    },
    headingTail: {
      fontFamily: INVOICE_FONT_SERIF,
      fontStyle: 'italic',
      fontWeight: 400,
      fontSize: 26.5,
      letterSpacing: -0.25,
      color: p.copper,
    },
    meta: {
      marginTop: 7,
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 8,
      fontWeight: 400,
      letterSpacing: 0.3,
      color: p.muted,
    },

    // ── The amount tile ────────────────────────
    hero: {
      position: 'relative',
      backgroundColor: p.tile,
      borderWidth: 0.75,
      borderColor: p.hairline,
      borderTopColor: p.tileRim,
      borderRadius: 12,
      paddingVertical: 18,
      paddingHorizontal: 20,
      marginBottom: 28,
    },
    heroTop: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
    },
    heroLabel: { marginBottom: 7 },
    heroAmount: {
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 30,
      fontWeight: 300,
      letterSpacing: -0.6,
      lineHeight: 1,
      color: p.ink,
    },

    // ── Chip ───────────────────────────────────
    chip: {
      paddingVertical: 3.5,
      paddingHorizontal: 8,
      borderRadius: 999,
      borderWidth: 0.75,
    },
    chipText: {
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 6.75,
      fontWeight: 500,
      letterSpacing: 0.55,
      textTransform: 'uppercase',
    },

    // ── Parties ────────────────────────────────
    parties: {
      flexDirection: 'row',
      gap: 36,
      marginBottom: 24,
    },
    party: { flex: 1 },
    partyHeading: { fontSize: 10.5, fontWeight: 600, color: p.ink, marginBottom: 4, letterSpacing: -0.1 },
    partyLine: { fontSize: 9.5, color: p.body, marginBottom: 1.5, lineHeight: 1.4 },

    // ── Table ──────────────────────────────────
    // Captions on a hairline, no filled band: the way every list in the
    // language is drawn.
    tableHeader: {
      flexDirection: 'row',
      borderBottomWidth: 0.75,
      borderBottomColor: p.hairlineStrong,
      paddingBottom: 8,
      paddingHorizontal: 10,
    },
    th: {
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 7,
      fontWeight: 400,
      letterSpacing: 1,
      textTransform: 'uppercase',
      color: p.muted,
    },
    tr: {
      flexDirection: 'row',
      paddingVertical: 10,
      paddingHorizontal: 10,
      alignItems: 'flex-start',
      borderBottomWidth: 0.5,
      borderBottomColor: p.row,
    },
    colDescription: { flex: 1, paddingRight: 12 },
    colQty: { width: 50, textAlign: 'right' },
    colRate: { width: 80, textAlign: 'right' },
    colAmount: { width: 90, textAlign: 'right' },
    tdDescription: { fontSize: 10, color: p.ink, lineHeight: 1.4, fontWeight: 500 },
    tdCaption: {
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 8,
      fontWeight: 400,
      color: p.muted,
      marginTop: 3,
      lineHeight: 1.35,
    },
    tdMono: {
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 9.5,
      fontWeight: 400,
      color: p.ink,
    },

    // ── Totals ─────────────────────────────────
    totalsWrap: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 20 },
    totalsBox: { width: 260 },
    totalsRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 7,
    },
    totalsRowNext: {
      borderTopWidth: 0.5,
      borderTopColor: p.row,
    },
    totalsValue: {
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 9.5,
      fontWeight: 400,
      color: p.body,
    },
    totalsRule: {
      height: 1,
      backgroundColor: p.accent,
      marginTop: 4,
      marginBottom: 6,
    },
    totalsFinal: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 5,
    },
    totalsFinalLabel: { fontSize: 10, fontWeight: 600, color: p.ink, letterSpacing: -0.1 },
    totalsFinalValue: {
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 16,
      fontWeight: 300,
      letterSpacing: -0.3,
      color: p.ink,
    },

    // ── Client portal callout ──────────────────
    callout: {
      marginTop: 22,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      paddingVertical: 14,
      paddingHorizontal: 16,
      backgroundColor: p.accentTile,
      borderWidth: 0.75,
      borderColor: p.accentBorder,
      borderRadius: 12,
    },
    calloutText: { flex: 1 },
    calloutTitle: { fontSize: 10, fontWeight: 600, color: p.ink, marginBottom: 2 },
    calloutBody: { fontSize: 8.5, color: p.body, lineHeight: 1.35, marginBottom: 5 },
    plainLink: { textDecoration: 'none' },
    calloutUrl: {
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 8,
      fontWeight: 400,
      color: p.accent,
    },
    pill: {
      position: 'relative',
      width: BUTTON.width,
      height: BUTTON.height,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
    },
    pillBg: { position: 'absolute', top: 0, left: 0 },
    pillText: { fontSize: 8.5, fontWeight: 600, color: BUTTON.text, letterSpacing: -0.05 },

    // ── Notes and instructions ─────────────────
    bottomBlocks: {
      flexDirection: 'row',
      gap: 36,
      marginTop: 32,
      paddingTop: 18,
      borderTopWidth: 0.5,
      borderTopColor: p.hairline,
    },
    bottomCol: { flex: 1 },
    bottomBody: { fontSize: 9, color: p.body, lineHeight: 1.55 },

    // ── Footer ─────────────────────────────────
    footerRule: {
      position: 'absolute',
      bottom: 38,
      left: PAGE_MARGIN_X,
      right: PAGE_MARGIN_X,
      height: 0.5,
      backgroundColor: p.hairline,
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
    footerText: {
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 7,
      fontWeight: 400,
      letterSpacing: 0.4,
      color: p.muted,
    },
    footerCenter: { textAlign: 'center', flex: 1 },

    // ── Status stamp (inside the amount tile) ──
    stamp: {
      position: 'absolute',
      top: 40,
      right: 22,
      paddingVertical: 6,
      paddingHorizontal: 14,
      borderWidth: 1,
      borderRadius: 4,
      transform: 'rotate(-6deg)',
      opacity: p.stampOpacity,
    },
    stampText: {
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 14,
      fontWeight: 500,
      letterSpacing: 4,
      textTransform: 'uppercase',
    },

    // ── Time logs page ─────────────────────────
    statRow: {
      flexDirection: 'row',
      gap: 10,
      marginBottom: 28,
    },
    statTile: {
      flex: 1,
      backgroundColor: p.tile,
      borderWidth: 0.75,
      borderColor: p.hairline,
      borderTopColor: p.tileRim,
      borderRadius: 10,
      paddingVertical: 12,
      paddingHorizontal: 14,
    },
    statTileWide: { flex: 1.6 },
    statLabel: { marginBottom: 6 },
    statValue: {
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 13,
      fontWeight: 300,
      letterSpacing: -0.2,
      color: p.ink,
    },
    tlColDate:        { width: 75, paddingRight: 8 },
    tlColTime:        { width: 115, paddingRight: 8 },
    tlColDescription: { flex: 1, paddingRight: 10 },
    tlColDuration:    { width: 64, paddingRight: 10, textAlign: 'right' },
    tlColAmount:      { width: 72, textAlign: 'right' },
    timeLogTotalValue: {
      fontFamily: INVOICE_FONT_MONO,
      fontSize: 14,
      fontWeight: 300,
      letterSpacing: -0.3,
      color: p.ink,
    },
  });
}
