import { Component, ElementRef, afterNextRender, inject, input, output, signal, viewChild } from '@angular/core';
import { Observable } from 'rxjs';
import { Api, errorMessage } from '../core/api';
import { WorkLocation } from '../core/models';

/**
 * Admin: the list of work locations offered in the quotation form and filter. Both firms share it.
 * Locations also join the list by themselves: every location block of an uploaded quotation sheet,
 * and any new location typed into a quotation.
 */
@Component({
  selector: 'app-locations-dialog',
  template: `
    <dialog
      #dialogEl
      class="m-auto p-0 w-[min(520px,calc(100vw-24px))] max-h-[calc(100dvh-24px)] rounded-2xl border-0 bg-surface text-ink shadow-2xl backdrop:bg-sidebar/55 backdrop:backdrop-blur-[2px]"
      aria-label="Work locations"
      (close)="closed.emit()"
    >
      <div class="flex flex-col max-h-[calc(100dvh-24px)]">
        <div class="flex items-center gap-3 px-6 py-4 border-b border-line">
          <span class="icon-tile violet"><span class="icon">location_on</span></span>
          <div class="flex-1 min-w-0">
            <h2 class="!text-lg">Work locations</h2>
            <p class="text-xs text-ink-3">Offered when adding a quotation, for both firms</p>
          </div>
          <button class="btn btn-ghost btn-sm !px-1.5" (click)="close()" aria-label="Close"><span class="icon">close</span></button>
        </div>

        <div class="flex-1 overflow-y-auto px-6 py-5">
          @if (error()) {
            <div class="alert error mb-4" role="alert"><span class="icon">error</span>{{ error() }}</div>
          }

          <form class="flex gap-2 mb-4" (submit)="$event.preventDefault(); add()">
            <input class="input flex-1" placeholder="New location, e.g. FMD 4" maxlength="60"
                   [value]="newName()" (input)="newName.set($any($event.target).value)" aria-label="New location" />
            <button type="submit" class="btn btn-primary" [disabled]="busy()"><span class="icon">add</span>Add</button>
          </form>

          <ul class="divide-y divide-line rounded-xl border border-line">
            @for (l of locations(); track l.name) {
              <li class="flex items-center gap-3 px-4 py-2.5">
                <span class="flex-1 min-w-0 font-medium truncate">{{ l.name }}</span>
                <span class="text-xs text-ink-3 tabular-nums">
                  {{ l.quotations ? l.quotations + (l.quotations === 1 ? ' quotation' : ' quotations') : 'Not used yet' }}
                </span>
                @if (l.id !== null && !l.quotations) {
                  <button class="btn btn-ghost btn-sm !text-critical-ink hover:!bg-critical-soft" (click)="remove(l.id)"
                          [disabled]="busy()" [attr.aria-label]="'Delete ' + l.name">
                    <span class="icon">delete</span>
                  </button>
                } @else {
                  <span class="w-9"></span>
                }
              </li>
            } @empty {
              <li class="px-4 py-6 text-center text-ink-3">No locations yet.</li>
            }
          </ul>
          <p class="mt-3 text-xs text-ink-3">A location that quotations still use can't be deleted.</p>
        </div>

        <div class="flex justify-end px-6 py-4 border-t border-line bg-surface-2 rounded-b-2xl">
          <button class="btn btn-primary" (click)="close()">Done</button>
        </div>
      </div>
    </dialog>
  `,
})
export class LocationsDialog {
  private api = inject(Api);

  readonly locations = input.required<WorkLocation[]>();
  /** The updated list, after an add or delete. */
  readonly changed = output<WorkLocation[]>();
  readonly closed = output<void>();

  private dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialogEl');
  protected newName = signal('');
  protected busy = signal(false);
  protected error = signal('');

  constructor() {
    afterNextRender(() => this.dialogEl().nativeElement.showModal());
  }

  add() {
    const name = this.newName().trim();
    if (!name) return this.error.set('Type the name of the location.');
    this.run(this.api.addLocation(name), () => this.newName.set(''));
  }

  remove(id: number) {
    this.run(this.api.deleteLocation(id));
  }

  private run(request: Observable<WorkLocation[]>, done?: () => void) {
    this.busy.set(true);
    this.error.set('');
    request.subscribe({
      next: (list) => {
        this.busy.set(false);
        done?.();
        this.changed.emit(list);
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }

  close() {
    this.dialogEl().nativeElement.close();
  }
}
