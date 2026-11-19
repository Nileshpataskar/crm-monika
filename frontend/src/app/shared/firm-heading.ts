import { Component, computed, inject, input, signal } from '@angular/core';
import { errorMessage } from '../core/api';
import { Auth } from '../core/auth';
import { Firms } from '../core/firms';

/** Page title with the firm's name under it. Admins can rename the firm right here. */
@Component({
  selector: 'app-firm-heading',
  template: `
    <div class="text-xs font-semibold uppercase tracking-wider text-accent">
      @if (editing()) {
        <form class="flex flex-wrap items-center gap-2 normal-case tracking-normal" (submit)="$event.preventDefault(); save()">
          <input class="input !h-8 w-64 max-w-full" maxlength="60" [value]="draft()" (input)="draft.set($any($event.target).value)"
                 (keydown.escape)="editing.set(false)" aria-label="Firm name" />
          <button type="submit" class="btn btn-primary btn-sm" [disabled]="saving()">Save</button>
          <button type="button" class="btn btn-ghost btn-sm" (click)="editing.set(false)">Cancel</button>
          @if (error()) { <span class="text-critical-ink text-[13px] font-medium">{{ error() }}</span> }
        </form>
      } @else {
        <span class="inline-flex items-center gap-1.5">
          <span class="icon !text-base normal-case">apartment</span>{{ name() }}
          @if (auth.isAdmin()) {
            <button class="text-ink-3 hover:text-accent" (click)="start()" title="Rename this firm" aria-label="Rename firm">
              <span class="icon !text-base normal-case">edit</span>
            </button>
          }
        </span>
      }
    </div>
    <h1 class="mt-1">{{ title() }}</h1>
  `,
})
export class FirmHeading {
  private firms = inject(Firms);
  protected auth = inject(Auth);

  readonly firm = input.required<number>();
  readonly title = input.required<string>();

  protected name = computed(() => this.firms.name(this.firm()));
  protected editing = signal(false);
  protected draft = signal('');
  protected saving = signal(false);
  protected error = signal('');

  start() {
    this.draft.set(this.name());
    this.error.set('');
    this.editing.set(true);
  }

  save() {
    const name = this.draft().trim();
    if (!name || name === this.name()) return this.editing.set(false);
    this.saving.set(true);
    this.firms.rename(this.firm(), name).subscribe({
      next: () => {
        this.saving.set(false);
        this.editing.set(false);
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }
}
