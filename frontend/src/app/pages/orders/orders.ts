import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';
import { tableColumns } from '../../core/columns';
import { Firms } from '../../core/firms';
import { CustomField, Order } from '../../core/models';
import { formatExtra } from '../../core/record-fields';
import { UploadDialog } from '../../core/upload-dialog';
import { ColumnsDialog } from '../../shared/columns-dialog';
import { saveResponse } from '../../shared/excel-viewer';
import { FirmHeading } from '../../shared/firm-heading';
import { InrPipe } from '../../shared/inr.pipe';
import { RecordForm } from '../../shared/record-form';
import { grnStatus, paymentStatus } from '../../shared/status';

type SortKey = 'order_date' | 'invoice_date' | 'total_amount';

/** Same definitions as backend/app/dashboard.py, so a dashboard count and this list always agree. */
const STATUS_FILTERS = {
  all: { label: 'Any status', test: (_: Order) => true },
  not_invoiced: { label: 'PO received, not invoiced', test: (o: Order) => !!o.po_number && !o.invoice_number },
  unpaid: { label: 'Unpaid', test: (o: Order) => !!o.invoice_number && o.payment_received !== true },
  paid: { label: 'Paid', test: (o: Order) => o.payment_received === true },
  dc_pending: { label: 'DC not received', test: (o: Order) => !!o.dc_number && o.dc_received !== true },
  grn_pending: { label: 'GRN pending', test: (o: Order) => !!o.invoice_number && o.grn_done === false },
};
type StatusFilter = keyof typeof STATUS_FILTERS;

interface Step {
  label: string;
  detail: string;
  state: 'done' | 'pending' | 'none';
}

@Component({
  selector: 'app-orders',
  imports: [FormsModule, InrPipe, DatePipe, RecordForm, ColumnsDialog, FirmHeading, RouterLink],
  templateUrl: './orders.html',
  // Esc closes the detail panel, unless a form or dialog is open on top of it (Esc closes that instead).
  host: { '(document:keydown.escape)': 'editing() || showColumns() || selected.set(null)' },
})
export class OrdersPage {
  private api = inject(Api);
  private upload = inject(UploadDialog);
  private firms = inject(Firms);
  protected auth = inject(Auth);
  protected paymentStatus = paymentStatus;
  protected formatExtra = formatExtra;
  protected grnStatus = grnStatus;

  // From the address: /orders/2?status=unpaid&vendor=67791 (the router fills these in).
  readonly firm = input.required<string>();
  readonly statusParam = input<string | undefined>(undefined, { alias: 'status' });
  readonly vendorParam = input<string | undefined>(undefined, { alias: 'vendor' });
  protected firmId = computed(() => Number(this.firm()));
  protected firmName = computed(() => this.firms.name(this.firmId()));
  /** Archived firms keep their data for looking at, but take no new entries. */
  protected archived = computed(() => !!this.firms.get(this.firmId())?.archived_at);

  protected orders = signal<Order[]>([]);
  protected fields = signal<CustomField[]>([]); // all custom columns (orders and quotations)
  protected orderFields = computed(() => this.fields().filter((f) => f.entity === 'orders'));
  protected columnOrder = signal<string[]>([]);
  /** The table's columns, in the order the admin arranged them. */
  protected columns = computed(() => tableColumns('orders', this.columnOrder(), this.fields()));
  protected loading = signal(true);
  protected error = signal('');

  // Filters: plain signals bound to the inputs with [(ngModel)].
  protected search = signal('');
  protected customer = signal('');
  protected vendor = signal('');
  protected status = signal<StatusFilter>('all');
  protected statusOptions = Object.entries(STATUS_FILTERS).map(([value, f]) => ({ value, label: f.label }));
  protected sortKey = signal<SortKey>('order_date');
  protected sortDesc = signal(true);

  protected selected = signal<Order | null>(null);
  /** The add/edit form: 'new', an order being edited, or null when closed. */
  protected editing = signal<Order | 'new' | null>(null);
  protected showColumns = signal(false);
  protected exporting = signal(false);

  /** Earlier values offered while typing in the form, e.g. customers and categories. */
  protected suggestions = computed(() => {
    const unique = (key: keyof Order) =>
      [...new Set(this.orders().map((o) => o[key]).filter((v): v is string => typeof v === 'string' && !!v))].sort();
    return Object.fromEntries(
      ['customer', 'vendor_code', 'category', 'delivery_location', 'unit', 'indentor'].map((k) => [k, unique(k as keyof Order)]),
    );
  });

  protected customers = computed(() =>
    [...new Set(this.orders().map((o) => o.customer).filter((c): c is string => !!c))].sort(),
  );

  protected vendors = computed(() =>
    [...new Set(this.orders().map((o) => o.vendor_code).filter((c): c is string => !!c))].sort(),
  );

  /** computed() re-runs automatically whenever a signal it reads changes, so the table updates as you type. */
  protected filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const key = this.sortKey();
    const dir = this.sortDesc() ? -1 : 1;
    return this.orders()
      .filter((o) => !this.customer() || o.customer === this.customer())
      .filter((o) => !this.vendor() || o.vendor_code === this.vendor())
      .filter(STATUS_FILTERS[this.status()].test)
      .filter((o) =>
        !q ||
        [o.description, o.po_number, o.vendor_code, o.invoice_number, o.indentor, o.category, o.quotation_number, o.dc_number,
         ...Object.values(o.extra ?? {}).map((v) => (v === null ? null : String(v)))]
          .some((v) => v?.toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        if (av === bv) return 0;
        if (av === null) return 1; // blanks always last
        if (bv === null) return -1;
        return av < bv ? -dir : dir;
      });
  });

  /** Clickable summary tiles at the top of the page. */
  protected tiles = computed(() => {
    const all = this.orders();
    const sum = (rows: Order[]) => rows.reduce((s, o) => s + (o.total_amount ?? 0), 0);
    const tile = (status: StatusFilter, label: string, icon: string, color: string) => {
      const rows = all.filter(STATUS_FILTERS[status].test);
      // "All" mixes billed and unbilled rows, and "not invoiced" rows have no amount yet, so no total for those.
      const amount = status === 'all' || status === 'not_invoiced' ? null : sum(rows);
      return { status, label, icon, color, count: rows.length, amount };
    };
    return [
      tile('all', 'All orders', 'inventory_2', 'green'),
      tile('not_invoiced', 'To bill', 'receipt_long', 'blue'),
      tile('unpaid', 'Unpaid', 'payments', 'orange'),
      tile('paid', 'Paid', 'account_balance', 'teal'),
    ];
  });

  protected filteredTotal = computed(() => this.filtered().reduce((sum, o) => sum + (o.total_amount ?? 0), 0));

  protected steps = computed<Step[]>(() => {
    const o = this.selected();
    if (!o) return [];
    const yesNo = (v: boolean | null): Step['state'] => (v ? 'done' : v === false ? 'pending' : 'none');
    return [
      { label: 'PO received', detail: o.po_number ? `PO ${o.po_number}` : 'No PO number yet', state: o.po_number ? 'done' : 'pending' },
      {
        label: 'Delivery challan',
        detail: o.dc_number ? `DC ${o.dc_number}${o.dc_received ? ', received back' : ', not received back'}` : 'No DC',
        state: o.dc_number ? yesNo(o.dc_received) : 'none',
      },
      { label: 'Invoiced', detail: o.invoice_number ? `Invoice #${o.invoice_number}` : 'Not invoiced yet', state: o.invoice_number ? 'done' : 'pending' },
      { label: 'Print + stamp', detail: o.print_stamp ? 'Done' : 'Not done', state: yesNo(o.print_stamp) },
      { label: 'GRN', detail: o.grn_done ? 'Complete' : o.grn_done === false ? 'Incomplete' : 'Not applicable', state: yesNo(o.grn_done) },
      { label: 'Payment received', detail: o.payment_received ? 'Received in bank' : 'Not received', state: o.payment_received ? 'done' : 'pending' },
    ];
  });

  constructor() {
    // Switching firm or following a dashboard link: start from that link's filters.
    effect(() => {
      this.firmId();
      const status = this.statusParam();
      const vendor = this.vendorParam() ?? '';
      untracked(() => {
        this.status.set(status && status in STATUS_FILTERS ? (status as StatusFilter) : 'all');
        this.vendor.set(vendor);
        this.customer.set('');
        this.search.set('');
        this.selected.set(null);
      });
    });
    // Load now, again for another firm, and whenever an Excel import or an edit finishes.
    effect(() => {
      this.upload.version();
      const firm = this.firmId();
      untracked(() => this.load(firm));
    });
  }

  private loadedFirm: number | null = null;

  load(firm = this.firmId()) {
    if (firm !== this.loadedFirm) this.loading.set(true); // a spinner for another firm, not for a refresh
    this.error.set('');
    forkJoin({ rows: this.api.orders(firm), fields: this.api.fields(), columns: this.api.columns() }).subscribe({
      next: ({ rows, fields, columns }) => {
        if (firm !== this.firmId()) return; // the user already moved on to the other firm
        this.orders.set(rows);
        this.fields.set(fields);
        this.columnOrder.set(columns.orders);
        this.loadedFirm = firm;
        // Keep the detail panel showing fresh data after an edit.
        const open = this.selected();
        if (open) this.selected.set(rows.find((o) => o.id === open.id) ?? null);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  sortBy(key: SortKey) {
    if (this.sortKey() === key) this.sortDesc.set(!this.sortDesc());
    else {
      this.sortKey.set(key);
      this.sortDesc.set(true);
    }
  }

  sortIcon(key: SortKey) {
    return this.sortKey() === key ? (this.sortDesc() ? '↓' : '↑') : '';
  }

  /** After saving or deleting in the form: reload, and tell the dashboard etc. to reload too. */
  onSaved() {
    this.upload.dataChanged();
  }

  onDeleted() {
    this.selected.set(null);
    this.upload.dataChanged();
  }

  exportExcel() {
    this.exporting.set(true);
    this.api.exportExcel('orders', this.firmId()).subscribe({
      next: (res) => {
        saveResponse(res, 'Orders.xlsx');
        this.exporting.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err, 'Export failed.'));
        this.exporting.set(false);
      },
    });
  }

  meta(o: Order) {
    return [o.category, o.delivery_location, o.indentor].filter(Boolean).join(' · ');
  }

  clearFilters() {
    this.search.set('');
    this.customer.set('');
    this.vendor.set('');
    this.status.set('all');
  }
}
