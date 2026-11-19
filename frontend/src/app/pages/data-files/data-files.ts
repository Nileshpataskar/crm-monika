import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Observable, forkJoin } from 'rxjs';
import { Api, errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';
import { Firms } from '../../core/firms';
import { DeleteResult, Period, Upload } from '../../core/models';
import { UploadDialog } from '../../core/upload-dialog';
import { ConfirmDialog } from '../../shared/confirm-dialog';
import { ExcelViewer, saveBlob, saveResponse } from '../../shared/excel-viewer';

interface PendingDelete {
  title: string;
  /** Runs the delete for real (dryRun = false) or just reports what would go (dryRun = true). */
  run: (dryRun: boolean) => Observable<DeleteResult>;
  preview: DeleteResult | null;
}

/** Months and files that are loaded: view the original Excel, download it, or delete its data. */
@Component({
  selector: 'app-data-files',
  imports: [DatePipe, ExcelViewer, ConfirmDialog],
  templateUrl: './data-files.html',
})
export class DataFilesPage {
  private api = inject(Api);
  protected auth = inject(Auth);
  protected upload = inject(UploadDialog);
  protected firms = inject(Firms);

  protected periods = signal<Period[]>([]);
  protected uploads = signal<Upload[]>([]);
  protected loading = signal(true);
  protected error = signal('');
  protected notice = signal('');

  protected viewing = signal<{ id: number; filename: string } | null>(null);
  protected pending = signal<PendingDelete | null>(null);
  protected deleting = signal(false);
  protected backingUp = signal<number | null>(null); // the firm whose backup is being prepared

  /** One section per firm: its months first, then its quotation years. */
  protected byFirm = computed(() =>
    this.firms.list().map((firm) => {
      const mine = this.periods().filter((p) => p.firm_id === firm.id);
      return { firm, periods: [...mine.filter((p) => p.type === 'orders'), ...mine.filter((p) => p.type === 'quotations')] };
    }),
  );
  /** upload id -> upload, to know whether a month's source file can still be opened */
  private uploadsById = computed(() => new Map(this.uploads().map((u) => [u.id, u])));

  constructor() {
    // Load now, and again after any import or delete.
    effect(() => {
      this.upload.version();
      untracked(() => this.load());
    });
  }

  load() {
    forkJoin({ periods: this.api.periods(), uploads: this.api.uploads() }).subscribe({
      next: ({ periods, uploads }) => {
        this.periods.set(periods);
        this.uploads.set(uploads);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  hasFile(uploadId: number) {
    return this.uploadsById().get(uploadId)?.has_file ?? false;
  }

  view(id: number, filename: string) {
    this.viewing.set({ id, filename });
  }

  download(u: Upload) {
    this.api.downloadUpload(u.id).subscribe({
      next: (blob) => saveBlob(blob, u.filename),
      error: (err) => this.error.set(errorMessage(err, 'Download failed.')),
    });
  }

  downloadBackup(firm: number) {
    this.backingUp.set(firm);
    this.api.exportExcel('all', firm).subscribe({
      next: (res) => {
        saveResponse(res, 'Backup.xlsx');
        this.backingUp.set(null);
      },
      error: (err) => {
        this.error.set(errorMessage(err, 'Backup failed.'));
        this.backingUp.set(null);
      },
    });
  }

  askDeletePeriod(p: Period) {
    const what = p.type === 'orders' ? p.label : `quotations ${p.label}`;
    this.ask(`Delete ${what} of ${this.firms.name(p.firm_id)}?`, (dryRun) => this.api.deletePeriod(p.firm_id, p.type, p.period, dryRun));
  }

  askDeleteUpload(u: Upload) {
    this.ask(`Delete ${u.filename}?`, (dryRun) => this.api.deleteUpload(u.id, dryRun));
  }

  /** Open the confirm box, and fill it with a dry run so it says exactly what will be removed. */
  private ask(title: string, run: PendingDelete['run']) {
    this.notice.set('');
    this.error.set('');
    this.pending.set({ title, run, preview: null });
    run(true).subscribe({
      next: (preview) => this.pending.update((p) => (p ? { ...p, preview } : p)),
      error: (err) => {
        this.pending.set(null);
        this.error.set(errorMessage(err));
      },
    });
  }

  confirmDelete() {
    const pending = this.pending();
    if (!pending) return;
    this.deleting.set(true);
    pending.run(false).subscribe({
      next: (res) => {
        const removed = res.deleted.map((d) => d.label).join(', ');
        this.notice.set(removed ? `Deleted ${removed}.` : 'Deleted.');
        this.pending.set(null);
        this.deleting.set(false);
        this.upload.dataChanged(); // dashboard, orders and this page reload
      },
      error: (err) => {
        this.error.set(errorMessage(err, 'Delete failed.'));
        this.pending.set(null);
        this.deleting.set(false);
      },
    });
  }

  rowsWord(type: string, n: number) {
    return type === 'orders' ? (n === 1 ? 'order' : 'orders') : n === 1 ? 'quotation' : 'quotations';
  }
}
