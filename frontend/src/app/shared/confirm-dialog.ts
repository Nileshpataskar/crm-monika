import { Component, ElementRef, afterNextRender, input, output, viewChild } from '@angular/core';

/**
 * "Are you sure?" box for destructive actions. The details go inside the tag:
 *   <app-confirm-dialog title="Delete June?" confirmLabel="Delete" (confirmed)="..." (cancelled)="...">...</app-confirm-dialog>
 */
@Component({
  selector: 'app-confirm-dialog',
  template: `
    <dialog
      #dialogEl
      class="m-auto p-0 w-[min(480px,calc(100vw-24px))] rounded-2xl border-0 bg-surface text-ink shadow-2xl backdrop:bg-sidebar/55"
      role="alertdialog"
      [attr.aria-label]="title()"
      (cancel)="$event.preventDefault(); !busy() && cancelled.emit()"
    >
      <div class="p-6">
        <div class="flex gap-4">
          <span class="grid place-items-center shrink-0 size-11 rounded-full bg-critical-soft text-critical">
            <span class="icon">delete</span>
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="!text-lg">{{ title() }}</h2>
            <div class="mt-2 text-ink-2 text-[13px] leading-relaxed"><ng-content /></div>
          </div>
        </div>
      </div>
      <div class="flex justify-end gap-2 px-6 py-4 bg-surface-2 border-t border-line rounded-b-2xl">
        <button class="btn" (click)="cancelled.emit()" [disabled]="busy()">Cancel</button>
        <button class="btn !bg-critical !border-critical !text-white hover:brightness-110" (click)="confirmed.emit()"
                [disabled]="busy() || !ready()">
          @if (busy()) { <span class="spinner"></span> Deleting… } @else { {{ confirmLabel() }} }
        </button>
      </div>
    </dialog>
  `,
})
export class ConfirmDialog {
  readonly title = input.required<string>();
  readonly confirmLabel = input('Delete');
  readonly busy = input(false);
  /** False while the details are still loading, so the user can't confirm blind. */
  readonly ready = input(true);
  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  private dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialogEl');

  constructor() {
    afterNextRender(() => this.dialogEl().nativeElement.showModal());
  }
}
