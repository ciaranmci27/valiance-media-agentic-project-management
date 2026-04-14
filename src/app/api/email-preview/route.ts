import { NextRequest, NextResponse } from 'next/server';
import { buildNotificationEmail } from '@/lib/email/templates/team/notification';
import { buildPortalWelcomeEmail, portalWelcomeDefaults } from '@/lib/email/templates/client/portal-welcome';
import { buildBudgetThresholdEmail, budgetThresholdDefaults } from '@/lib/email/templates/client/budget-threshold';
import { buildProjectSummaryEmail, projectSummaryDefaults } from '@/lib/email/templates/client/project-summary';
import { buildDollarIntervalEmail, dollarIntervalDefaults } from '@/lib/email/templates/client/dollar-interval';
import { buildBudgetExtendedEmail, budgetExtendedDefaults } from '@/lib/email/templates/client/budget-extended';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const template = req.nextUrl.searchParams.get('template') || 'portal-welcome';

  let html = '';

  const portalUrl = 'https://example.com/portal/acme-rebrand';

  switch (template) {
    // ── Team Templates ──────────────────────────────────────────────

    case 'team-task-assigned': {
      const result = buildNotificationEmail({
        title: 'New task assigned to you',
        message: 'Sarah assigned you to "Design homepage wireframes" on the Acme Corp Rebrand project.',
        link: '/projects/acme-corp-rebrand',
        details: [
          { label: 'Project', value: 'Acme Corp Rebrand' },
          { label: 'Priority', value: 'High' },
          { label: 'Due Date', value: 'Apr 20, 2026' },
        ],
      });
      html = result.html;
      break;
    }

    case 'team-task-status': {
      const result = buildNotificationEmail({
        title: '"Design homepage wireframes" moved to In Progress',
        message: 'Marcus updated the task status on Acme Corp Rebrand.',
        link: '/projects/acme-corp-rebrand',
        details: [
          { label: 'Project', value: 'Acme Corp Rebrand' },
          { label: 'From', value: 'To Do' },
          { label: 'To', value: 'In Progress' },
        ],
      });
      html = result.html;
      break;
    }

    case 'team-task-comment': {
      const result = buildNotificationEmail({
        title: 'New comment on "Design homepage wireframes"',
        message: 'Sarah: "Pushed up the latest revision. The hero section is cleaner now, but I\'m still not sure about the CTA placement. Thoughts?"',
        link: '/projects/acme-corp-rebrand',
        details: [
          { label: 'Project', value: 'Acme Corp Rebrand' },
          { label: 'Task', value: 'Design homepage wireframes' },
        ],
      });
      html = result.html;
      break;
    }

    case 'team-project-created': {
      const result = buildNotificationEmail({
        title: 'New project: "Bloomwell Health App"',
        message: 'Jessica created a new project.',
        link: '/projects/bloomwell-health-app',
        details: [
          { label: 'Client', value: 'Bloomwell Health' },
          { label: 'Budget', value: '$42,000' },
          { label: 'Timeline', value: '12 weeks' },
        ],
      });
      html = result.html;
      break;
    }

    case 'team-lead-converted': {
      const result = buildNotificationEmail({
        title: 'Lead "Northbound Coffee Co." converted to project',
        message: 'Marcus converted the lead after the proposal was accepted.',
        link: '/leads/northbound-coffee',
        details: [
          { label: 'Lead Value', value: '$28,500' },
          { label: 'Priority', value: 'Hot' },
          { label: 'Services', value: 'Branding, Web Design' },
        ],
      });
      html = result.html;
      break;
    }

    case 'team-lead-status': {
      const result = buildNotificationEmail({
        title: 'Lead "Northbound Coffee Co." moved to Proposal Sent',
        message: 'Sarah updated the lead status.',
        link: '/leads/northbound-coffee',
      });
      html = result.html;
      break;
    }

    case 'team-minimal': {
      const result = buildNotificationEmail({
        title: 'Contact "Alex Rivera" was deleted',
        message: 'Marcus removed a contact.',
      });
      html = result.html;
      break;
    }

    // ── Client Templates ────────────────────────────────────────────

    case 'portal-welcome': {
      const result = buildPortalWelcomeEmail({
        projectName: 'Acme Corp Rebrand',
        clientName: 'Sarah',
        portalUrl,
        slots: portalWelcomeDefaults({
          projectName: 'Acme Corp Rebrand',
          portalWelcomeMessage: 'Welcome to your project portal! Here you can track our progress, review deliverables, and stay up to date on everything happening with your rebrand.',
        }),
      });
      html = result.html;
      break;
    }

    case 'budget-threshold-hours': {
      const result = buildBudgetThresholdEmail({
        projectName: 'Acme Corp Rebrand',
        clientName: 'Sarah',
        portalUrl,
        budgetType: 'hours',
        budgetValue: 80,
        currentUsage: 61.5,
        thresholdPct: 75,
        slots: budgetThresholdDefaults({ projectName: 'Acme Corp Rebrand', thresholdPct: 75, budgetType: 'hours' }),
      });
      html = result.html;
      break;
    }

    case 'budget-threshold-amount': {
      const result = buildBudgetThresholdEmail({
        projectName: 'NeoForge Website',
        clientName: 'Marcus',
        portalUrl: 'https://example.com/portal/neoforge-website',
        logoUrl: 'https://placehold.co/80x80/3A5959/ffffff/png?text=NF',
        budgetType: 'amount',
        budgetValue: 18000,
        currentUsage: 16250,
        thresholdPct: 90,
        slots: budgetThresholdDefaults({ projectName: 'NeoForge Website', thresholdPct: 90, budgetType: 'amount' }),
      });
      html = result.html;
      break;
    }

    case 'dollar-interval': {
      const result = buildDollarIntervalEmail({
        projectName: 'Acme Corp Rebrand',
        clientName: 'Sarah',
        portalUrl,
        milestone: 2000,
        totalAccrued: 2150,
        hourlyRate: 150,
        totalHours: 14.3,
        slots: dollarIntervalDefaults({ projectName: 'Acme Corp Rebrand', milestone: 2000 }),
      });
      html = result.html;
      break;
    }

    case 'budget-extended': {
      const result = buildBudgetExtendedEmail({
        projectName: 'Acme Corp Rebrand',
        clientName: 'Sarah',
        portalUrl,
        oldBudget: 10000,
        oldBudgetType: 'amount',
        newBudget: 15000,
        newBudgetType: 'amount',
        currentUsage: 8200,
        slots: budgetExtendedDefaults({
          projectName: 'Acme Corp Rebrand',
          oldBudget: 10000,
          oldBudgetType: 'amount',
          newBudget: 15000,
          newBudgetType: 'amount',
        }),
      });
      html = result.html;
      break;
    }

    case 'project-summary': {
      const result = buildProjectSummaryEmail({
        projectName: 'Acme Corp Rebrand',
        clientName: 'Sarah',
        portalUrl,
        unpaidHours: 12.5,
        hourlyRate: 150,
        currentBalance: 1875,
        lastPaymentDate: '2026-03-15',
        lastPaymentAmount: 3000,
        budgetType: 'hours',
        budgetValue: 80,
        budgetUsed: 61.5,
        slots: projectSummaryDefaults({ projectName: 'Acme Corp Rebrand' }),
      });
      html = result.html;
      break;
    }

    case 'project-summary-caught-up': {
      const result = buildProjectSummaryEmail({
        projectName: 'Acme Corp Rebrand',
        clientName: 'Sarah',
        portalUrl,
        logoUrl: 'https://placehold.co/80x80/3A5959/ffffff/png?text=A',
        unpaidHours: 0,
        hourlyRate: 150,
        currentBalance: 0,
        lastPaymentDate: '2026-04-01',
        lastPaymentAmount: 1875,
        budgetType: 'hours',
        budgetValue: 80,
        budgetUsed: 61.5,
        slots: projectSummaryDefaults({ projectName: 'Acme Corp Rebrand' }),
      });
      html = result.html;
      break;
    }

    case 'project-summary-no-budget': {
      const result = buildProjectSummaryEmail({
        projectName: 'Bloomwell Health App',
        clientName: 'Jessica',
        portalUrl: 'https://example.com/portal/bloomwell-health',
        unpaidHours: 8.25,
        hourlyRate: 175,
        currentBalance: 1443.75,
        lastPaymentDate: '2026-02-28',
        lastPaymentAmount: 5250,
        budgetType: null,
        budgetValue: null,
        budgetUsed: null,
        slots: projectSummaryDefaults({ projectName: 'Bloomwell Health App' }),
      });
      html = result.html;
      break;
    }

    default:
      html = '<p>Unknown template</p>';
  }

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
