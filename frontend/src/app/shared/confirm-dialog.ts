import { Component, ElementRef, afterNextRender, input, output, viewChild } from '@angular/core';

/**
 * "Are you sure?" box. Red for deleting (the default); danger=false for milder actions like archiving.
 * The details go inside the tag:
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
          <span class="grid place-items-center shrink-0 size-11 rounded-full"
                [class]="danger() ? 'bg-critical-soft text-critical' : 'bg-warning-soft text-warning-ink'">
            <span class="icon">{{ danger() ? 'delete' : 'help' }}</span>
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="!text-lg">{{ title() }}</h2>
            <div class="mt-2 text-ink-2 text-[13px] leading-relaxed"><ng-content /></div>
          </div>
        </div>
      </div>
      <div class="flex justify-end gap-2 px-6 py-4 bg-surface-2 border-t border-line rounded-b-2xl">
        <button class="btn" (click)="cancelled.emit()" [disabled]="busy()">Cancel</button>
        <button class="btn" [class]="danger() ? '!bg-critical !border-critical !text-white hover:brightness-110' : 'btn-primary'"
                (click)="confirmed.emit()" [disabled]="busy() || !ready()">
          @if (busy()) { <span class="spinner"></span> {{ danger() ? 'Deleting…' : 'Saving…' }} } @else { {{ confirmLabel() }} }
        </button>
      </div>
    </dialog>
  `,
})
export class ConfirmDialog {
  readonly title = input.required<string>();
  readonly confirmLabel = input('Delete');
  readonly busy = input(false);
  readonly danger = input(true);
  /** False while the details are still loading, so the user can't confirm blind. */
  readonly ready = input(true);
  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  private dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialogEl');

  constructor() {
    afterNextRender(() => this.dialogEl().nativeElement.showModal());
  }
}
