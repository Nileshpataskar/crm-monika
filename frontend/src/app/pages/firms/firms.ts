import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Observable } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';
import { Firms } from '../../core/firms';
import { Firm, FirmSummary } from '../../core/models';
import { UploadDialog } from '../../core/upload-dialog';
import { ConfirmDialog } from '../../shared/confirm-dialog';
import { FirmForm } from '../../shared/firm-form';
import { InrPipe } from '../../shared/inr.pipe';

interface PendingAction {
  title: string;
  confirmLabel: string;
  danger: boolean;
  message: string;
  run: () => Observable<unknown>;
  done: string;
}

/** "1 order", "3 orders" */
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Admin: add firms, edit their details, put them in order, archive or delete them. */
@Component({
  selector: 'app-firms',
  imports: [DatePipe, RouterLink, FirmForm, ConfirmDialog, InrPipe],
  templateUrl: './firms.html',
})
export class FirmsPage {
  private api = inject(Api);
  protected auth = inject(Auth);
  protected firms = inject(Firms);
  private data = inject(UploadDialog);

  protected summary = signal<Map<number, FirmSummary>>(new Map());
  protected loading = signal(true);
  protected error = signal('');
  protected notice = signal('');
  protected editing = signal<Firm | 'new' | null>(null);
  protected pending = signal<PendingAction | null>(null);
  protected busy = signal(false);

  protected archived = computed(() => this.firms.list().filter((f) => f.archived_at));

  constructor() {
    // Load now, and again whenever data changes (an upload, a delete...).
    effect(() => {
      this.data.version();
      untracked(() => this.load());
    });
  }

  load() {
    this.firms.load();
    this.api.firmsSummary().subscribe({
      next: (rows) => {
        this.summary.set(new Map(rows.map((r) => [r.firm_id, r])));
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  stats(firm: Firm): FirmSummary {
    return this.summary().get(firm.id) ??
      { firm_id: firm.id, orders: 0, quotations: 0, uploads: 0, invoiced: 0, received: 0, outstanding: 0, last_upload: null };
  }

  hasData(firm: Firm) {
    const s = this.stats(firm);
    return s.orders + s.quotations + s.uploads > 0;
  }

  initials(name: string) {
    return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  }

  onSaved(firm: Firm, wasNew: boolean) {
    this.notice.set(wasNew ? `Added ${firm.name}. It now has its own Orders and Quotations in the menu.` : `Saved ${firm.name}.`);
    this.load();
  }

  move(firm: Firm, direction: 'up' | 'down') {
    this.firms.move(firm.id, direction).subscribe({ error: (err) => this.error.set(errorMessage(err)) });
  }

  askArchive(firm: Firm) {
    const s = this.stats(firm);
    this.ask({
      title: `Archive ${firm.name}?`,
      confirmLabel: 'Archive',
      danger: false,
      message: `It leaves the menu, the upload window and the dashboard totals. Its ${count(s.orders, 'order')}, ` +
        `${count(s.quotations, 'quotation')} and ${count(s.uploads, 'uploaded file')} are kept, and you can restore it any time.`,
      run: () => this.firms.save({ archived: true }, firm.id),
      done: `${firm.name} is archived.`,
    });
  }

  restore(firm: Firm) {
    this.firms.save({ archived: false }, firm.id).subscribe({
      next: () => this.notice.set(`${firm.name} is back in the menu.`),
      error: (err) => this.error.set(errorMessage(err)),
    });
  }

  askDelete(firm: Firm) {
    this.ask({
      title: `Delete ${firm.name}?`,
      confirmLabel: 'Delete firm',
      danger: true,
      message: 'The firm has no orders, quotations or uploads, so nothing else is removed. This can\'t be undone.',
      run: () => this.firms.remove(firm.id),
      done: `${firm.name} was deleted.`,
    });
  }

  private ask(action: PendingAction) {
    this.notice.set('');
    this.error.set('');
    this.pending.set(action);
  }

  confirm() {
    const action = this.pending();
    if (!action) return;
    this.busy.set(true);
    action.run().subscribe({
      next: () => {
        this.busy.set(false);
        this.pending.set(null);
        this.notice.set(action.done);
        this.data.dataChanged(); // the dashboard and menus reload
      },
      error: (err) => {
        this.busy.set(false);
        this.pending.set(null);
        this.error.set(errorMessage(err));
      },
    });
  }
}
