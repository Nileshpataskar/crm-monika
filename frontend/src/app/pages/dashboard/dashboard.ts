import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';
import { Firms } from '../../core/firms';
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

const UPLOAD_LINK: QuickLink = { label: 'Upload Excel sheet', hint: 'PO summary or quotations', icon: 'upload_file', tile: 'green', action: 'upload', adminOnly: true };
const USERS_LINK: QuickLink = { label: 'Manage users', hint: 'Add staff, reset passwords', icon: 'group', tile: 'teal', link: '/users', adminOnly: true };

@Component({
  selector: 'app-dashboard',
  imports: [BarChart, DonutChart, InrPipe, DatePipe, RouterLink, NgTemplateOutlet],
  templateUrl: './dashboard.html',
})
export class DashboardPage {
  private api = inject(Api);
  protected auth = inject(Auth);
  protected upload = inject(UploadDialog);
  protected firms = inject(Firms);
  protected agingStatus = agingStatus;
  protected Math = Math;

  /** ?firm=2 in the address: show only that firm. No value: all active firms together. */
  readonly firm = input<string>();
  protected selectedFirm = computed(() => (this.firm() ? Number(this.firm()) : null));
  /** The firms whose numbers are on screen. */
  protected shownFirms = computed(() => {
    const id = this.selectedFirm();
    return id ? this.firms.list().filter((f) => f.id === id) : this.firms.active();
  });

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

  protected quickLinks = computed(() =>
    [
      UPLOAD_LINK,
      ...this.shownFirms().flatMap((f): QuickLink[] => [
        { label: `${f.name}: unpaid`, hint: 'Invoices to chase', icon: 'payments', tile: 'orange', link: `/orders/${f.id}`, query: { status: 'unpaid' } },
        { label: `${f.name}: quotes awaiting PO`, hint: 'Follow up with indentors', icon: 'request_quote', tile: 'violet', link: `/quotations/${f.id}`, query: { status: 'open' } },
      ]),
      USERS_LINK,
    ].filter((q) => !q.adminOnly || this.auth.isAdmin()),
  );

  protected isEmpty = computed(() => {
    const k = this.data()?.kpis;
    return !!k && k.orders === 0 && k.open_quotes === 0 && k.won_quotes === 0;
  });

  protected receivedPercent = computed(() => {
    const k = this.data()?.kpis;
    return k && k.invoiced_total ? Math.round((k.received_total / k.invoiced_total) * 100) : 0;
  });

  /** "Needs attention" tiles, like the Priority Level panel in the old Zoho app. Each shows the count
   *  for both firms together, and a link per firm to that firm's orders with the filter on. */
  protected attention = computed(() => {
    const a = this.data()?.attention;
    if (!a) return [];
    const tile = (label: string, rows: { firm_id: number }[], icon: string, tileColor: string, status: string) => ({
      label, icon, tile: tileColor, status, count: rows.length,
      perFirm: this.shownFirms().map((f) => ({ id: f.id, name: f.name, count: rows.filter((r) => r.firm_id === f.id).length })),
    });
    return [
      tile('Unpaid invoices', a.unpaid_invoices, 'payments', 'orange', 'unpaid'),
      tile('Work to bill', a.to_invoice, 'receipt_long', 'blue', 'not_invoiced'),
      tile('DC not received', a.dc_not_received, 'local_shipping', 'amber', 'dc_pending'),
      tile('GRN pending', a.grn_pending, 'fact_check', 'violet', 'grn_pending'),
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
    // Runs once now, again whenever data changes (upload.version), and when another firm is chosen.
    effect(() => {
      this.upload.version();
      const firm = this.selectedFirm();
      untracked(() => this.load(firm));
    });
  }

  load(firm: number | null) {
    this.loading.set(true);
    this.error.set('');
    // forkJoin runs both requests in parallel and waits for both to finish.
    forkJoin({ dashboard: this.api.dashboard(firm), uploads: this.api.uploads() }).subscribe({
      next: ({ dashboard, uploads }) => {
        this.data.set(dashboard);
        this.lastUpload.set(uploads.find((u) => !firm || u.firm_id === firm) ?? null);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }
}
