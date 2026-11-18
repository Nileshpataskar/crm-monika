import { Component, ElementRef, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { HttpResponse } from '@angular/common/http';
import { Api, errorMessage } from '../core/api';
import { UploadView } from '../core/models';

/** Shows an uploaded workbook like a spreadsheet: one tab per sheet, Excel row numbers on the left. */
@Component({
  selector: 'app-excel-viewer',
  templateUrl: './excel-viewer.html',
})
export class ExcelViewer {
  private api = inject(Api);

  readonly uploadId = input.required<number>();
  readonly filename = input.required<string>();
  readonly closed = output<void>();

  private dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialogEl');

  protected view = signal<UploadView | null>(null);
  protected error = signal('');
  protected tab = signal(0);
  protected filter = signal('');
  protected downloading = signal(false);

  protected sheet = computed(() => this.view()?.sheets[this.tab()] ?? null);

  /** Rows containing the search text in any cell. */
  protected rows = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const rows = this.sheet()?.rows ?? [];
    return q ? rows.filter((r) => r.cells.some((c) => c.toLowerCase().includes(q))) : rows;
  });

  constructor() {
    afterNextRender(() => {
      this.dialogEl().nativeElement.showModal();
      this.api.viewUpload(this.uploadId()).subscribe({
        next: (v) => {
          this.view.set(v);
          // Open on the first sheet that has real data.
          this.tab.set(Math.max(0, v.sheets.findIndex((s) => s.type)));
        },
        error: (err) => this.error.set(errorMessage(err, 'Could not open this file.')),
      });
    });
  }

  download() {
    this.downloading.set(true);
    this.api.downloadUpload(this.uploadId()).subscribe({
      next: (blob) => {
        saveBlob(blob, this.filename());
        this.downloading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err, 'Download failed.'));
        this.downloading.set(false);
      },
    });
  }

  close() {
    this.dialogEl().nativeElement.close(); // fires (close), which emits `closed`
  }

  onBackdropClick(event: MouseEvent) {
    if (event.target === this.dialogEl().nativeElement) this.close();
  }

  sheetType(type: string | null) {
    return type === 'orders' ? 'PO summary' : type === 'quotations' ? 'Quotations' : 'Not imported';
  }
}

/** Make the browser save a downloaded Blob as a file. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Save a file download, using the name the server gave it (Content-Disposition) when there is one. */
export function saveResponse(res: HttpResponse<Blob>, fallback: string) {
  const match = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') ?? '');
  saveBlob(res.body!, match?.[1] ?? fallback);
}
