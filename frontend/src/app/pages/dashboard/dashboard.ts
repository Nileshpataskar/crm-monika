import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';
import { UploadDialog } from '../../core/upload-dialog';
import { Dashboard, Upload } from '../../core/models';
import { BarChart, BarSeries } from '../../shared/bar-chart';
import { DonutChart, DonutSlice } from '../../shared/donut-chart';
import { InrPipe } from '../../shared/inr.pipe';
import { agingStatus } from '../../shared/status';

interface QuickLink {
  label: string;
  hint: string;
  icon: string;
  tile: string;
  link?: string; // a page to open, or...
  action?: 'upload'; // ...something to do instead
  query?: Record<string, string>;
  adminOnly?: boolean;
}

const QUICK_LINKS: QuickLink[] = [
  { label: 'Upload Excel sheet', hint: 'PO summary or quotations', icon: 'upload_file', tile: 'green', action: 'upload', adminOnly: true },
  { label: 'Unpaid invoices', hint: 'Chase payments', icon: 'payments', tile: 'orange', link: '/orders', query: { status: 'unpaid' } },
  { label: 'Work to bill', hint: 'PO received, no invoice', icon: 'receipt_long', tile: 'blue', link: '/orders', query: { status: 'not_invoiced' } },
  { label: 'Quotes awaiting PO', hint: 'Follow up with indentors', icon: 'request_quote', tile: 'violet', link: '/quotations', query: { status: 'open' } },
  { label: 'Manage users', hint: 'Add staff, reset passwords', icon: 'group', tile: 'teal', link: '/users', adminOnly: true },
];

@Component({
  selector: 'app-dashboard',
  imports: [BarChart, DonutChart, InrPipe, DatePipe, RouterLink, NgTemplateOutlet],
  templateUrl: './dashboard.html',
})
export class DashboardPage {
  private api = inject(Api);
  protected auth = inject(Auth);
  protected upload = inject(UploadDialog);
  protected agingStatus = agingStatus;
  protected Math = Math;

  protected data = signal<Dashboard | null>(null);
  protected lastUpload = signal<Upload | null>(null);
  protected loading = signal(true);
  protected error = signal('');

  protected greeting = computed(() => {
    const hour = new Date().getHours();
    const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const firstName = this.auth.user()?.full_name.split(' ')[0];
    return firstName ? `${part}, ${firstName}` : part;
  });

  protected quickLinks = computed(() => QUICK_LINKS.filter((q) => !q.adminOnly || this.auth.isAdmin()));

  protected isEmpty = computed(() => {
    const k = this.data()?.kpis;
    return !!k && k.orders === 0 && k.open_quotes === 0 && k.won_quotes === 0;
  });

  protected receivedPercent = computed(() => {
    const k = this.data()?.kpis;
    return k && k.invoiced_total ? Math.round((k.received_total / k.invoiced_total) * 100) : 0;
  });

  /** Clickable "needs attention" tiles, like the Priority Level panel in the old Zoho app. */
  protected attention = computed(() => {
    const a = this.data()?.attention;
    if (!a) return [];
    return [
      { label: 'Unpaid invoices', count: a.unpaid_invoices.length, icon: 'payments', tile: 'orange', status: 'unpaid' },
      { label: 'Work to bill', count: a.to_invoice.length, icon: 'receipt_long', tile: 'blue', status: 'not_invoiced' },
      { label: 'DC not received', count: a.dc_not_received.length, icon: 'local_shipping', tile: 'amber', status: 'dc_pending' },
      { label: 'GRN pending', count: a.grn_pending.length, icon: 'fact_check', tile: 'violet', status: 'grn_pending' },
    ];
  });

  // ----- chart inputs, derived from the API data -----
  protected collection = computed<DonutSlice[]>(() => {
    const k = this.data()?.kpis;
    return [
      { label: 'Received', value: k?.received_total ?? 0, color: 'series-1' },
      { label: 'Outstanding', value: k?.outstanding_total ?? 0, color: 'series-2' },
    ];
  });

  protected customerChart = computed(() => {
    const rows = this.data()?.by_customer ?? [];
    return {
      labels: rows.map((r) => r.customer),
      series: [
        { label: 'Received', data: rows.map((r) => r.received), color: 'series-1' },
        { label: 'Outstanding', data: rows.map((r) => r.outstanding), color: 'series-2' },
      ] satisfies BarSeries[],
    };
  });

  protected monthChart = computed(() => {
    const rows = this.data()?.by_month ?? [];
    return {
      labels: rows.map((r) => new Date(r.month + '-01').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })),
      series: [{ label: 'Invoiced', data: rows.map((r) => r.invoiced), color: 'series-1' }] satisfies BarSeries[],
    };
  });

  protected categoryChart = computed(() => {
    const rows = this.data()?.by_category ?? [];
    return {
      labels: rows.map((r) => r.category),
      series: [{ label: 'Orders', data: rows.map((r) => r.orders), color: 'series-1' }] satisfies BarSeries[],
    };
  });


  constructor() {
    // Runs once now, and again whenever an Excel import finishes (upload.version changes).
    effect(() => {
      this.upload.version();
      untracked(() => this.load());
    });
  }

  load() {
    this.loading.set(true);
    this.error.set('');
    // forkJoin runs both requests in parallel and waits for both to finish.
    forkJoin({ dashboard: this.api.dashboard(), uploads: this.api.uploads() }).subscribe({
      next: ({ dashboard, uploads }) => {
        this.data.set(dashboard);
        this.lastUpload.set(uploads[0] ?? null);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }
}
