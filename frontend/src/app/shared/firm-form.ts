import { Component, ElementRef, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { errorMessage } from '../core/api';
import { Firms } from '../core/firms';
import { Firm, FirmInput } from '../core/models';

type Key = 'name' | 'gstin' | 'contact_person' | 'phone' | 'email' | 'address' | 'notes';

const FIELDS: { key: Key; label: string; placeholder?: string; area?: boolean; wide?: boolean; hint?: string }[] = [
  { key: 'name', label: 'Firm name', placeholder: 'Siddhivinayak Enterprises', wide: true },
  { key: 'gstin', label: 'GSTIN', placeholder: '27ABCDE1234F1Z5', hint: '15 characters' },
  { key: 'contact_person', label: 'Contact person', placeholder: 'Sagar Gaikwad' },
  { key: 'phone', label: 'Phone', placeholder: '+91 98220 12345' },
  { key: 'email', label: 'Email', placeholder: 'accounts@example.com' },
  { key: 'address', label: 'Address', area: true, wide: true },
  { key: 'notes', label: 'Notes', area: true, wide: true, hint: 'Anything worth remembering, e.g. payment terms' },
];

// Same checks as backend/app/firms.py, so most mistakes are caught before sending.
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^[0-9+\-() ]{7,20}$/;

/** Add a firm (firm = null) or edit one's details. */
@Component({
  selector: 'app-firm-form',
  template: `
    <dialog #dialogEl
      class="m-auto p-0 w-[min(640px,calc(100vw-24px))] max-h-[calc(100dvh-24px)] rounded-2xl border-0 bg-surface text-ink shadow-2xl backdrop:bg-sidebar/55 backdrop:backdrop-blur-[2px]"
      [attr.aria-label]="isNew() ? 'Add firm' : 'Edit firm'" (close)="closed.emit()" (cancel)="saving() && $event.preventDefault()">
      <form class="flex flex-col max-h-[calc(100dvh-24px)]" (submit)="$event.preventDefault(); save()" novalidate>
        <div class="flex items-center gap-3 px-6 py-4 border-b border-line">
          <span class="icon-tile green"><span class="icon">{{ isNew() ? 'add_business' : 'apartment' }}</span></span>
          <div class="flex-1 min-w-0">
            <h2 class="!text-lg">{{ isNew() ? 'Add a firm' : 'Edit ' + firm()!.name }}</h2>
            <p class="text-xs text-ink-3">Only the name is required. The rest can be filled in later.</p>
          </div>
          <button type="button" class="btn btn-ghost btn-sm !px-1.5" (click)="close()" aria-label="Close"><span class="icon">close</span></button>
        </div>

        <div class="flex-1 overflow-y-auto px-6 py-5 grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
          @for (f of fields; track f.key) {
            <div class="flex flex-col gap-1.5" [class]="f.wide ? 'sm:col-span-2' : ''">
              <label class="label" [for]="'firm-' + f.key">{{ f.label }} @if (f.key === 'name') { <span class="text-critical">*</span> }</label>
              @if (f.area) {
                <textarea [id]="'firm-' + f.key" rows="2" class="input !h-auto py-2 resize-y" [placeholder]="f.placeholder ?? ''"
                          [value]="values()[f.key]" (input)="set(f.key, $any($event.target).value)"></textarea>
              } @else {
                <input [id]="'firm-' + f.key" class="input" [placeholder]="f.placeholder ?? ''" autocomplete="off"
                       [type]="f.key === 'email' ? 'email' : f.key === 'phone' ? 'tel' : 'text'"
                       [attr.maxlength]="f.key === 'name' ? 60 : 200" [value]="values()[f.key]" (input)="set(f.key, $any($event.target).value)" />
              }
              @if (f.hint) { <span class="text-xs text-ink-3">{{ f.hint }}</span> }
            </div>
          }
        </div>

        <div class="flex flex-wrap items-center justify-end gap-2 px-6 py-4 border-t border-line bg-surface-2 rounded-b-2xl">
          @if (error()) {
            <div class="alert error w-full mb-1" role="alert"><span class="icon">error</span>{{ error() }}</div>
          }
          <button type="button" class="btn" (click)="close()" [disabled]="saving()">Cancel</button>
          <button type="submit" class="btn btn-primary" [disabled]="saving()">
            @if (saving()) { <span class="spinner"></span> Saving… } @else { <span class="icon">check</span>{{ isNew() ? 'Add firm' : 'Save changes' }} }
          </button>
        </div>
      </form>
    </dialog>
  `,
})
export class FirmForm {
  private firms = inject(Firms);

  readonly firm = input<Firm | null>(null); // null = new firm
  readonly saved = output<Firm>();
  readonly closed = output<void>();

  private dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialogEl');
  protected fields = FIELDS;
  protected values = signal<Record<Key, string>>(this.empty());
  private initial = this.empty();
  protected saving = signal(false);
  protected error = signal('');
  protected isNew = computed(() => !this.firm());

  constructor() {
    afterNextRender(() => {
      const firm = this.firm();
      const start = this.empty();
      for (const f of FIELDS) start[f.key] = firm?.[f.key] ?? '';
      this.values.set(start);
      this.initial = { ...start };
      this.dialogEl().nativeElement.showModal();
    });
  }

  private empty(): Record<Key, string> {
    return { name: '', gstin: '', contact_person: '', phone: '', email: '', address: '', notes: '' };
  }

  set(key: Key, value: string) {
    this.values.update((v) => ({ ...v, [key]: value }));
    this.error.set('');
  }

  private check(): string | null {
    const v = this.values();
    const gstin = v.gstin.trim().toUpperCase().replace(/ /g, '');
    if (!v.name.trim()) return 'Firm name is required.';
    if (gstin && !GSTIN.test(gstin)) return 'GSTIN should be 15 characters, like 27ABCDE1234F1Z5.';
    if (v.email.trim() && !EMAIL.test(v.email.trim())) return "That email address doesn't look right.";
    if (v.phone.trim() && !PHONE.test(v.phone.trim())) return 'Phone number: 7 to 20 digits (spaces, +, - and brackets are fine).';
    return null;
  }

  save() {
    const problem = this.check();
    if (problem) return this.error.set(problem);
    // New firm: send what's filled in. Edit: send only what changed ("" clears a field).
    const body: FirmInput = {};
    for (const f of FIELDS) {
      const value = this.values()[f.key];
      if (this.isNew() ? value.trim() : value !== this.initial[f.key]) body[f.key] = value.trim();
    }
    if (!this.isNew() && !Object.keys(body).length) return this.close();

    this.saving.set(true);
    this.firms.save(body, this.firm()?.id).subscribe({
      next: (firm) => {
        this.saving.set(false);
        this.saved.emit(firm);
        this.close();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(errorMessage(err, 'Could not save the firm.'));
      },
    });
  }

  close() {
    this.dialogEl().nativeElement.close();
  }
}
