import { Component, ElementRef, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { Observable } from 'rxjs';
import { Api, errorMessage } from '../core/api';
import { CustomField, Entity, Order, Quotation } from '../core/models';
import { FormField, formSections } from '../core/record-fields';
import { ConfirmDialog } from './confirm-dialog';
import { InrPipe } from './inr.pipe';

type Row = Order | Quotation;

/**
 * Add or edit one order / quotation. Every input works with a string (that's what <input> gives);
 * values are converted to numbers, dates and yes/no only when saving.
 */
@Component({
  selector: 'app-record-form',
  imports: [ConfirmDialog, InrPipe],
  templateUrl: './record-form.html',
})
export class RecordForm {
  private api = inject(Api);

  readonly entity = input.required<Entity>();
  readonly row = input<Row | null>(null); // null = new
  readonly firm = input.required<number>(); // a new row is added to this firm
  readonly customFields = input<CustomField[]>([]);
  readonly suggestions = input<Record<string, string[]>>({});
  readonly saved = output<Row>();
  readonly deleted = output<void>();
  readonly closed = output<void>();

  private dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialogEl');

  protected values = signal<Record<string, string>>({});
  private initial: Record<string, string> = {};
  protected saving = signal(false);
  protected error = signal('');
  protected confirmDelete = signal(false);
  protected deleting = signal(false);
  /** Choice fields where the user picked "New…" and is typing a value that isn't in the list. */
  protected typingNew = signal<Record<string, boolean>>({});

  protected sections = computed(() => formSections(this.entity(), this.customFields()));
  protected isNew = computed(() => !this.row());
  protected noun = computed(() => (this.entity() === 'orders' ? 'order' : 'quotation'));

  /** Live total for orders, the same way the server works it out (9% + 9% unless typed in). */
  protected total = computed(() => {
    const v = this.values();
    const amount = parseFloat(v['amount']);
    if (this.entity() !== 'orders' || isNaN(amount)) return null;
    const tax = (key: string) => (v[key] === '' || v[key] === undefined ? Math.round(amount * 9) / 100 : parseFloat(v[key]) || 0);
    return amount + tax('cgst') + tax('sgst');
  });

  constructor() {
    afterNextRender(() => {
      this.values.set(this.fromRow());
      this.initial = { ...this.values() };
      this.dialogEl().nativeElement.showModal();
    });
  }

  /** The row's current values as strings for the inputs. */
  private fromRow(): Record<string, string> {
    const row = this.row() as Record<string, any> | null;
    const result: Record<string, string> = {};
    for (const field of this.sections().flatMap((s) => s.fields)) {
      const value = field.custom ? row?.['extra']?.[field.key] : row?.[field.key];
      result[field.key] = value === null || value === undefined ? '' : String(value);
    }
    return result;
  }

  set(key: string, value: string) {
    this.values.update((v) => ({ ...v, [key]: value }));
    this.error.set(''); // the message was about the old values
  }

  /** The list for a choice field, plus the row's current value if it isn't in the list. */
  choices(field: FormField): string[] {
    const list = this.suggestions()[field.key] ?? [];
    const current = this.values()[field.key];
    return current && !list.includes(current) ? [current, ...list] : list;
  }

  initialValue(key: string) {
    return this.initial[key] ?? '';
  }

  pickChoice(field: FormField, value: string) {
    if (value === '__new__') {
      this.typingNew.update((t) => ({ ...t, [field.key]: true }));
      this.set(field.key, '');
    } else {
      this.set(field.key, value);
    }
  }

  datalistId(field: FormField) {
    return field.suggest ? `suggest-${this.entity()}-${field.key}` : null;
  }

  private convert(field: FormField, text: string): string | number | boolean | null {
    const value = text.trim();
    if (value === '') return null;
    if (field.type === 'number') return Number(value);
    if (field.type === 'yesno') return value === 'true';
    return value;
  }

  /** Browser-side checks, so the common mistakes are caught before sending. */
  private check(): string | null {
    for (const field of this.sections().flatMap((s) => s.fields)) {
      const value = (this.values()[field.key] ?? '').trim();
      if (field.required && !value) return `${field.label} is required.`;
      if (field.type === 'number' && value && (isNaN(Number(value)) || Number(value) < 0)) {
        return `${field.label} must be a number, 0 or more.`;
      }
    }
    const v = this.values();
    if (v['order_date'] && v['invoice_date'] && v['invoice_date'] < v['order_date']) {
      return "Invoice date can't be before the order date.";
    }
    return null;
  }

  save() {
    const problem = this.check();
    if (problem) return this.error.set(problem);

    // New rows: send everything filled in. Edits: send only what changed (empty = cleared).
    const body: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};
    for (const field of this.sections().flatMap((s) => s.fields)) {
      const text = this.values()[field.key] ?? '';
      const changed = this.isNew() ? text.trim() !== '' : text !== this.initial[field.key];
      if (!changed) continue;
      (field.custom ? extra : body)[field.key] = this.convert(field, text);
    }
    if (Object.keys(extra).length) body['extra'] = extra;
    if (this.isNew()) body['firm_id'] = this.firm();
    if (!this.isNew() && !Object.keys(body).length) return this.close();

    this.saving.set(true);
    this.error.set('');
    const id = this.row()?.id;
    const request: Observable<Row> =
      this.entity() === 'orders' ? this.api.saveOrder(body, id) : this.api.saveQuotation(body, id);
    request.subscribe({
      next: (row) => {
        this.saving.set(false);
        this.saved.emit(row);
        this.close();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(errorMessage(err, 'Could not save.'));
      },
    });
  }

  remove() {
    const row = this.row();
    if (!row) return;
    this.deleting.set(true);
    this.api.deleteRow(this.entity(), row.id).subscribe({
      next: () => {
        this.deleting.set(false);
        this.confirmDelete.set(false);
        this.deleted.emit();
        this.close();
      },
      error: (err) => {
        this.deleting.set(false);
        this.confirmDelete.set(false);
        this.error.set(errorMessage(err, 'Could not delete.'));
      },
    });
  }

  close() {
    this.dialogEl().nativeElement.close(); // fires (close), which emits `closed`
  }
}
