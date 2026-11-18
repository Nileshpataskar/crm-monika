import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { forkJoin } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';
import { CustomField, Quotation } from '../../core/models';
import { formatExtra } from '../../core/record-fields';
import { UploadDialog } from '../../core/upload-dialog';
import { ColumnsDialog } from '../../shared/columns-dialog';
import { saveResponse } from '../../shared/excel-viewer';
import { InrPipe } from '../../shared/inr.pipe';
import { RecordForm } from '../../shared/record-form';
import { quoteStatus, workStatus } from '../../shared/status';

const STATUS_FILTERS = {
  all: (_: Quotation) => true,
  open: (q: Quotation) => !q.po_number,
  won: (q: Quotation) => !!q.po_number,
  completed: (q: Quotation) => !!q.work_completed,
  not_completed: (q: Quotation) => !q.work_completed,
};
type StatusFilter = keyof typeof STATUS_FILTERS;

@Component({
  selector: 'app-quotations',
  imports: [FormsModule, InrPipe, RecordForm, ColumnsDialog],
  templateUrl: './quotations.html',
})
export class QuotationsPage {
  private api = inject(Api);
  private upload = inject(UploadDialog);
  private route = inject(ActivatedRoute);
  protected auth = inject(Auth);
  protected formatExtra = formatExtra;
  protected quoteStatus = quoteStatus;
  protected workStatus = workStatus;

  protected quotes = signal<Quotation[]>([]);
  protected fields = signal<CustomField[]>([]);
  protected quoteFields = computed(() => this.fields().filter((f) => f.entity === 'quotations'));
  /** The add/edit form: 'new', a quotation being edited, or null when closed. */
  protected editing = signal<Quotation | 'new' | null>(null);
  protected showColumns = signal(false);
  protected exporting = signal(false);

  protected suggestions = computed(() => {
    const unique = (key: keyof Quotation) =>
      [...new Set(this.quotes().map((q) => q[key]).filter((v): v is string => typeof v === 'string' && !!v))].sort();
    return { work_location: unique('work_location'), work_type: unique('work_type'), indentor: unique('indentor') };
  });
  protected loading = signal(true);
  protected error = signal('');

  protected search = signal('');
  protected location = signal('');
  // Start from ?status=open etc. when we arrive from a dashboard link.
  protected status = signal<StatusFilter>(this.statusFromUrl());

  protected locations = computed(() =>
    [...new Set(this.quotes().map((q) => q.work_location).filter((l): l is string => !!l))].sort(),
  );

  protected filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    return this.quotes()
      .filter((x) => !this.location() || x.work_location === this.location())
      .filter(STATUS_FILTERS[this.status()])
      .filter((x) =>
        !q ||
        [x.work_title, x.quote_number, x.indentor, x.po_number, x.work_type,
         ...Object.values(x.extra ?? {}).map((v) => (v === null ? null : String(v)))]
          .some((v) => v?.toLowerCase().includes(q)),
      );
  });

  /** Clickable summary tiles at the top of the page. */
  protected tiles = computed(() => {
    const all = this.quotes();
    const tile = (status: StatusFilter, label: string, icon: string, color: string, amount: (q: Quotation) => number | null) => {
      const rows = all.filter(STATUS_FILTERS[status]);
      return { status, label, icon, color, count: rows.length, amount: rows.reduce((s, q) => s + (amount(q) ?? 0), 0) };
    };
    return [
      tile('all', 'All quotations', 'request_quote', 'violet', (q) => q.total_amount ?? q.po_amount),
      tile('open', 'Awaiting PO', 'hourglass_top', 'amber', (q) => q.total_amount),
      tile('won', 'PO received', 'task_alt', 'green', (q) => q.po_amount),
      tile('completed', 'Work completed', 'engineering', 'blue', (q) => q.po_amount ?? q.total_amount),
    ];
  });

  protected summary = computed(() => {
    const rows = this.filtered();
    return {
      quoted: rows.reduce((s, x) => s + (x.total_amount ?? 0), 0),
      po: rows.reduce((s, x) => s + (x.po_amount ?? 0), 0),
    };
  });

  constructor() {
    // Load now, and again whenever an Excel import finishes.
    effect(() => {
      this.upload.version();
      untracked(() => this.load());
    });
  }

  load() {
    forkJoin({ rows: this.api.quotations(), fields: this.api.fields() }).subscribe({
      next: ({ rows, fields }) => {
        this.quotes.set(rows);
        this.fields.set(fields);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  /** Admins open the edit form by clicking a row. */
  open(q: Quotation) {
    if (this.auth.isAdmin()) this.editing.set(q);
  }

  /** After saving or deleting: reload this page and the dashboard. */
  onChanged() {
    this.upload.dataChanged();
  }

  exportExcel() {
    this.exporting.set(true);
    this.api.exportExcel('quotations').subscribe({
      next: (res) => {
        saveResponse(res, 'Quotations.xlsx');
        this.exporting.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err, 'Export failed.'));
        this.exporting.set(false);
      },
    });
  }

  clearFilters() {
    this.search.set('');
    this.location.set('');
    this.status.set('all');
  }

  private statusFromUrl(): StatusFilter {
    const value = this.route.snapshot.queryParamMap.get('status');
    return value && value in STATUS_FILTERS ? (value as StatusFilter) : 'all';
  }
}
