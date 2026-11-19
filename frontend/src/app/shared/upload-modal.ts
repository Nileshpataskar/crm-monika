import { DatePipe } from '@angular/common';
import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, errorMessage } from '../core/api';
import { Firms } from '../core/firms';
import { Period, Upload, UploadPlan, UploadResult } from '../core/models';
import { UploadDialog } from '../core/upload-dialog';

const MAX_MB = 4; // must match MAX_UPLOAD_MB in backend/app/main.py

type Step = 'pick' | 'checking' | 'preview' | 'importing' | 'done';

/**
 * Floating upload window. Flow: choose file -> browser checks (type, size) -> server dry run
 * shows what will happen to each sheet -> user confirms -> import.
 */
@Component({
  selector: 'app-upload-modal',
  imports: [DatePipe, RouterLink],
  templateUrl: './upload-modal.html',
})
export class UploadModal {
  private api = inject(Api);
  protected dialog = inject(UploadDialog);
  protected firms = inject(Firms);
  // Named dialogEl, not dialog: a template #ref with the same name as a property would hide it.
  private dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialogEl');

  protected step = signal<Step>('pick');
  protected file = signal<File | null>(null);
  protected dragging = signal(false);
  protected error = signal('');
  protected plan = signal<UploadPlan | null>(null);
  protected result = signal<UploadResult | null>(null);
  protected periods = signal<Period[]>([]);
  protected recent = signal<Upload[]>([]);

  /** Which firm the file is for. Everything (replacing months, the preview) happens inside that firm. */
  protected firm = signal<number | null>(null);
  protected firmName = computed(() => this.firms.name(this.firm()));
  private firmPeriods = computed(() => this.periods().filter((p) => p.firm_id === this.firm()));
  protected monthsLoaded = computed(() => this.firmPeriods().filter((p) => p.type === 'orders'));
  protected yearsLoaded = computed(() => this.firmPeriods().filter((p) => p.type === 'quotations'));
  protected busy = computed(() => this.step() === 'checking' || this.step() === 'importing');

  constructor() {
    // Keep the native <dialog> in sync with the service's isOpen signal.
    effect(() => {
      const el = this.dialogEl().nativeElement;
      if (this.dialog.isOpen() && !el.open) {
        this.reset();
        // Start with the firm whose page is open, if it's active (archived firms take no uploads).
        const start = this.dialog.firm();
        this.firm.set(this.firms.active().some((f) => f.id === start) ? start : null);
        this.loadInfo();
        el.showModal(); // showModal() = centred, with backdrop, Esc closes, focus stays inside
      } else if (!this.dialog.isOpen() && el.open) {
        el.close();
      }
    });
  }

  private loadInfo() {
    this.api.periods().subscribe((p) => this.periods.set(p));
    this.api.uploads().subscribe((u) => this.recent.set(u));
  }

  reset() {
    this.step.set('pick');
    this.file.set(null);
    this.plan.set(null);
    this.result.set(null);
    this.error.set('');
  }

  /** Step 1: checks we can do in the browser, before sending anything. */
  /** The latest upload for the chosen firm. */
  protected lastUpload = computed(() => this.recent().find((u) => u.firm_id === this.firm()) ?? null);

  pick(files: FileList | null) {
    this.error.set('');
    if (!files?.length) return;
    const firm = this.firm();
    if (firm === null) return this.error.set('First choose which firm this file is for.');
    if (files.length > 1) return this.error.set('Please choose one file at a time.');
    const file = files[0];
    if (!/\.(xlsx|xlsm)$/i.test(file.name)) {
      return this.error.set(`"${file.name}" is not an Excel .xlsx file. Old .xls files: open in Excel and use Save As → .xlsx.`);
    }
    if (file.size === 0) return this.error.set(`"${file.name}" is empty.`);
    if (file.size > MAX_MB * 1024 * 1024) return this.error.set(`"${file.name}" is ${this.fileSize(file.size)}. The limit is ${MAX_MB} MB.`);

    // Step 2: the server reads the file and tells us what importing it would do.
    this.file.set(file);
    this.step.set('checking');
    this.api.previewUpload(file, firm).subscribe({
      next: (plan) => {
        this.plan.set(plan);
        this.step.set('preview');
      },
      error: (err) => {
        this.error.set(errorMessage(err, 'Could not check this file.'));
        this.file.set(null);
        this.step.set('pick');
      },
    });
  }

  /** Step 3: the user confirmed, so import for real. */
  confirmImport() {
    const file = this.file();
    const firm = this.firm();
    if (!file || firm === null || !this.plan()?.can_import) return;
    this.step.set('importing');
    this.api.uploadExcel(file, firm).subscribe({
      next: (res) => {
        this.result.set(res);
        this.step.set('done');
        this.dialog.dataChanged(); // pages listening to `version` reload their data
        this.loadInfo();
      },
      error: (err) => {
        this.error.set(errorMessage(err, 'Import failed. Nothing was saved.'));
        this.step.set('preview');
      },
    });
  }

  onDrop(event: DragEvent) {
    event.preventDefault(); // stop the browser from opening the file
    this.dragging.set(false);
    if (!this.busy()) this.pick(event.dataTransfer?.files ?? null);
  }

  onDragOver(event: DragEvent) {
    event.preventDefault(); // needed so the browser allows dropping here
    this.dragging.set(true);
  }

  /** Clicking the dimmed area outside the box closes it (the click target is the <dialog> itself). */
  onBackdropClick(event: MouseEvent) {
    if (event.target === this.dialogEl().nativeElement && !this.busy()) this.dialog.close();
  }

  /** Esc key: the browser closes the <dialog>; keep our signal in step. Block it mid-import. */
  onCancel(event: Event) {
    if (this.busy()) event.preventDefault();
  }

  sheetLabel(type: string | null) {
    return type === 'orders' ? 'PO summary' : type === 'quotations' ? 'Quotations' : 'Skipped';
  }

  fileSize(bytes: number) {
    return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
}
