import {
  Mail,
  Send,
  ArrowRight,
  Code,
} from 'lucide-react';
import { DocsTocNav, type TocSection } from '@/app/api/docs/DocsTocNav';

/* ── Helpers ───────────────────────────────────────────────── */

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="bg-zinc-900 rounded-lg p-4 overflow-x-auto">
      <pre className="text-sm text-zinc-300 font-mono whitespace-pre">{children}</pre>
    </div>
  );
}

function ParamTable({ title, params }: {
  title: string;
  params: { name: string; type: string; required?: boolean; desc: string }[];
}) {
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">{title}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border border-zinc-100 rounded-lg overflow-hidden">
          <thead>
            <tr className="bg-zinc-50 border-b border-zinc-200">
              <th className="text-left py-2 px-3 text-xs font-medium text-zinc-500">Name</th>
              <th className="text-left py-2 px-3 text-xs font-medium text-zinc-500">Type</th>
              <th className="text-left py-2 px-3 text-xs font-medium text-zinc-500">Required</th>
              <th className="text-left py-2 px-3 text-xs font-medium text-zinc-500">Description</th>
            </tr>
          </thead>
          <tbody>
            {params.map(p => (
              <tr key={p.name} className="border-b border-zinc-50 last:border-0">
                <td className="py-2 px-3"><code className="text-brand-600 font-mono text-xs">{p.name}</code></td>
                <td className="py-2 px-3"><code className="text-zinc-400 font-mono text-xs">{p.type}</code></td>
                <td className="py-2 px-3">
                  {p.required ? <span className="text-red-500 text-xs font-medium">Yes</span> : <span className="text-zinc-300 text-xs">No</span>}
                </td>
                <td className="py-2 px-3 text-zinc-600 text-xs">{p.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────── */

export default function SmtpDocsPage() {
  const tocSections: TocSection[] = [
    { id: 'transactional', label: 'Transactional', mobileLabel: 'Transactional', mobilePill: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' },
    { id: 'relay', label: 'Relay', mobileLabel: 'Relay', mobilePill: 'bg-blue-50 text-blue-700 hover:bg-blue-100' },
    { id: 'return-value', label: 'Return Value', mobileLabel: 'Returns' },
    { id: 'examples', label: 'Examples', mobileLabel: 'Examples', mobilePill: 'bg-violet-50 text-violet-700 hover:bg-violet-100' },
  ];

  return (
    <div>
      {/* ── Page header ── */}
      <header className="bg-white border-b border-zinc-200">
        <div className="max-w-7xl mx-auto px-4 lg:px-6 py-6">
          <div className="flex items-center gap-3.5">
            <div className="p-2.5 bg-cyan-50 rounded-xl">
              <Mail className="text-cyan-600" size={24} />
            </div>
            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-2xl font-bold text-zinc-900">Sending Email</h1>
                <span className="px-2 py-0.5 text-xs font-semibold bg-cyan-50 text-cyan-600 rounded-full">
                  SMTP
                </span>
              </div>
              <p className="text-sm text-zinc-500 mt-1">
                Two functions for sending email — transactional (app to user) and relay (form to team).
              </p>
            </div>
          </div>
        </div>
      </header>

      <DocsTocNav sections={tocSections} infoCutoff={0}>
        <main className="space-y-6 min-w-0">

          {/* ── sendTransactional ── */}
          <section id="transactional" className="scroll-mt-16 lg:scroll-mt-6">
            <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2 bg-emerald-50 rounded-lg">
                  <Send className="text-emerald-600" size={20} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold text-zinc-900">sendTransactional</h2>
                    <span className="px-1.5 py-0.5 text-[10px] font-medium bg-emerald-50 text-emerald-600 rounded">App &rarr; User</span>
                  </div>
                  <p className="text-sm text-zinc-500">Emails sent by your application to users</p>
                </div>
              </div>

              <p className="text-sm text-zinc-600 mb-4">
                Use this for any email your app sends directly to a user: confirmations, receipts,
                password resets, notifications, status updates. The email is sent from the SMTP
                account&apos;s configured <strong>From Name</strong> and <strong>From Email</strong>,
                with the account&apos;s <strong>Reply-To</strong> if set.
              </p>

              <CodeBlock>{`import { sendTransactional } from '@/lib/email/send-mail';

await sendTransactional({
  to: 'user@example.com',
  subject: 'Your order has been confirmed',
  html: '<h1>Order #1234 confirmed</h1><p>Thank you for your purchase.</p>',
});`}</CodeBlock>

              <ParamTable title="Options" params={[
                { name: 'to', type: 'string | string[]', required: true, desc: 'Recipient email address(es)' },
                { name: 'subject', type: 'string', required: true, desc: 'Email subject line' },
                { name: 'html', type: 'string', required: true, desc: 'HTML email body' },
                { name: 'text', type: 'string', required: false, desc: 'Plaintext fallback body' },
                { name: 'accountId', type: 'string', required: false, desc: 'Use a specific SMTP account instead of the primary' },
              ]} />
            </div>
          </section>

          {/* ── sendRelay ── */}
          <section id="relay" className="scroll-mt-16 lg:scroll-mt-6">
            <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2 bg-blue-50 rounded-lg">
                  <Mail className="text-blue-600" size={20} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold text-zinc-900">sendRelay</h2>
                    <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-50 text-blue-600 rounded">Form &rarr; Team</span>
                  </div>
                  <p className="text-sm text-zinc-500">Relay form submissions to your team</p>
                </div>
              </div>

              <p className="text-sm text-zinc-600 mb-4">
                Use this for contact forms, support requests, and inquiries — anywhere an external
                person submits a form and your team needs to receive it. The <strong>From name</strong> shows
                the submitter&apos;s name, the <strong>From email</strong> stays as your account&apos;s domain
                (so SPF/DKIM pass), and <strong>Reply-To</strong> is set to the submitter&apos;s email so
                your team can reply directly.
              </p>

              <CodeBlock>{`import { sendRelay } from '@/lib/email/send-mail';

await sendRelay({
  subject: \`New inquiry from \${formData.name}\`,
  html: \`<p>\${formData.message}</p>\`,
  sender: { name: formData.name, email: formData.email },
  // 'to' omitted — delivers to the account's from_email (your inbox)
});`}</CodeBlock>

              <ParamTable title="Options" params={[
                { name: 'subject', type: 'string', required: true, desc: 'Email subject line' },
                { name: 'html', type: 'string', required: true, desc: 'HTML email body' },
                { name: 'sender', type: '{ name, email }', required: true, desc: 'The form submitter\'s name and email' },
                { name: 'to', type: 'string | string[]', required: false, desc: 'Recipient(s). Defaults to the account\'s from_email (your inbox)' },
                { name: 'text', type: 'string', required: false, desc: 'Plaintext fallback body' },
                { name: 'accountId', type: 'string', required: false, desc: 'Use a specific SMTP account instead of the primary' },
              ]} />
            </div>
          </section>

          {/* ── Return Value ── */}
          <section id="return-value" className="scroll-mt-16 lg:scroll-mt-6">
            <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2 bg-zinc-100 rounded-lg">
                  <Code className="text-zinc-600" size={20} />
                </div>
                <div>
                  <h2 className="font-semibold text-zinc-900">Return Value</h2>
                  <p className="text-sm text-zinc-500">Both functions return the same result shape</p>
                </div>
              </div>

              <CodeBlock>{`interface SendMailResult {
  success: boolean;
  messageId?: string;  // Present on success
  error?: string;      // Present on failure
}`}</CodeBlock>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                <div>
                  <p className="text-xs font-medium text-emerald-600 uppercase tracking-wide mb-2">Success</p>
                  <CodeBlock>{`{
  success: true,
  messageId: "<abc123@mail.example.com>"
}`}</CodeBlock>
                </div>
                <div>
                  <p className="text-xs font-medium text-red-600 uppercase tracking-wide mb-2">Failure</p>
                  <CodeBlock>{`{
  success: false,
  error: "Connection timeout"
}`}</CodeBlock>
                </div>
              </div>

              <div className="mt-4 p-3 bg-zinc-50 rounded-lg border border-zinc-100">
                <p className="text-sm font-medium text-zinc-700 mb-1">Account resolution order</p>
                <div className="flex items-center gap-2 text-sm text-zinc-600 flex-wrap mt-2">
                  <span className="px-2 py-1 bg-white border border-zinc-200 rounded font-mono text-xs">accountId</span>
                  <ArrowRight size={14} className="text-zinc-400" />
                  <span className="px-2 py-1 bg-white border border-zinc-200 rounded font-mono text-xs">primary account</span>
                  <ArrowRight size={14} className="text-zinc-400" />
                  <span className="px-2 py-1 bg-white border border-zinc-200 rounded font-mono text-xs">oldest account</span>
                </div>
              </div>
            </div>
          </section>

          {/* ── Examples ── */}
          <section id="examples" className="scroll-mt-16 lg:scroll-mt-6">
            <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2 bg-violet-50 rounded-lg">
                  <Code className="text-violet-600" size={20} />
                </div>
                <div>
                  <h2 className="font-semibold text-zinc-900">Examples</h2>
                  <p className="text-sm text-zinc-500">Common patterns</p>
                </div>
              </div>

              <div className="space-y-6">
                {/* Task notification */}
                <div>
                  <p className="text-sm font-medium text-zinc-900 mb-2">Task assignment notification</p>
                  <CodeBlock>{`import { sendTransactional } from '@/lib/email/send-mail';

const result = await sendTransactional({
  to: assignee.email,
  subject: \`New task: \${task.title}\`,
  html: \`
    <h2>You've been assigned a task</h2>
    <p><strong>\${task.title}</strong></p>
    <p>\${task.description}</p>
    <a href="\${baseUrl}/tasks/\${task.id}">View Task</a>
  \`,
});

if (!result.success) {
  console.error('Failed to notify:', result.error);
}`}</CodeBlock>
                </div>

                {/* Contact form */}
                <div className="pt-5 border-t border-zinc-100">
                  <p className="text-sm font-medium text-zinc-900 mb-2">Contact form handler</p>
                  <CodeBlock>{`import { sendRelay } from '@/lib/email/send-mail';

export async function POST(request: Request) {
  const { name, email, message } = await request.json();

  const result = await sendRelay({
    subject: \`Contact form: \${name}\`,
    html: \`
      <h2>New Contact Submission</h2>
      <p><strong>From:</strong> \${name} &lt;\${email}&gt;</p>
      <hr />
      <p>\${message}</p>
    \`,
    sender: { name, email },
  });

  if (!result.success) {
    return NextResponse.json({ error: 'Failed to send' }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}`}</CodeBlock>
                </div>

                {/* Multiple recipients */}
                <div className="pt-5 border-t border-zinc-100">
                  <p className="text-sm font-medium text-zinc-900 mb-2">Send to multiple recipients</p>
                  <CodeBlock>{`await sendTransactional({
  to: ['alice@example.com', 'bob@example.com'],
  subject: 'Weekly project summary',
  html: summaryHtml,
});`}</CodeBlock>
                </div>

                {/* Specific account */}
                <div className="pt-5 border-t border-zinc-100">
                  <p className="text-sm font-medium text-zinc-900 mb-2">Use a specific SMTP account</p>
                  <CodeBlock>{`// Bypass the primary account by passing an accountId
await sendTransactional({
  to: 'client@example.com',
  subject: 'Invoice #1234',
  html: invoiceHtml,
  accountId: 'uuid-of-billing-smtp-account',
});`}</CodeBlock>
                </div>
              </div>
            </div>
          </section>

        </main>
      </DocsTocNav>
    </div>
  );
}
