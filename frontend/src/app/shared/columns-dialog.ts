import { Component, ElementRef, afterNextRender, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { Observable } from 'rxjs';
import { Api, errorMessage } from '../core/api';
import { customKey, tableColumns } from '../core/columns';
import { CustomField, Entity, FieldType } from '../core/models';
import { ConfirmDialog } from './confirm-dialog';

const TYPES: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'yesno', label: 'Yes / No' },
];

/** Admin: put the Orders or Quotations columns in any order, and add, rename and remove custom columns. */
@Component({
  selector: 'app-columns-dialog',
  imports: [ConfirmDialog],
  templateUrl: './columns-dialog.html',
})
export class ColumnsDialog {
  private api = inject(Api);

  readonly entity = input.required<Entity>();
  readonly fields = input.required<CustomField[]>();
  /** The saved column order (see core/columns.ts). */
  readonly order = input.required<string[]>();
  /** Something changed: the page reloads its columns and rows. */
  readonly changed = output<void>();
  readonly closed = output<void>();

  private dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialogEl');

  protected types = TYPES;
  protected newLabel = signal('');
  protected newType = signal<FieldType>('text');
  /** Key of the column the new one goes after; '' = at the start. */
  protected newAfter = signal('');
  protected editingId = signal<number | null>(null);
  protected editLabel = signal('');
  protected removing = signal<CustomField | null>(null);
  protected busy = signal(false);
  protected error = signal('');

  /** Shown at once when moving, before the server answers, so the arrows feel instant. */
  private localOrder = signal<string[] | null>(null);
  protected columns = computed(() => tableColumns(this.entity(), this.localOrder() ?? this.order(), this.fields()));
  protected noun = computed(() => (this.entity() === 'orders' ? 'Orders' : 'Quotations'));

  constructor() {
    afterNextRender(() => this.dialogEl().nativeElement.showModal());
    // New columns go just before Status unless the admin picks another place.
    effect(() => {
      const cols = this.columns();
      untracked(() => {
        if (!this.newAfter() || !cols.some((c) => c.key === this.newAfter())) {
          const status = cols.findIndex((c) => c.key === 'status');
          this.newAfter.set(cols[(status === -1 ? cols.length : status) - 1]?.key ?? '');
        }
      });
    });
  }

  /** Move a column one place left (-1) or right (+1) in the table. */
  move(index: number, step: -1 | 1) {
    const keys = this.columns().map((c) => c.key);
    const target = index + step;
    if (target < 0 || target >= keys.length) return;
    [keys[index], keys[target]] = [keys[target], keys[index]];
    this.localOrder.set(keys);
    this.run(this.api.saveColumns(this.entity(), keys), () => {}, () => this.localOrder.set(null));
  }

  typeLabel(type: FieldType) {
    return TYPES.find((t) => t.value === type)?.label ?? type;
  }

  add() {
    const label = this.newLabel().trim();
    if (!label) return this.error.set('Type a name for the new column.');
    this.run(this.api.createField(this.entity(), label, this.newType(), this.newAfter()), (field) => {
      this.newLabel.set('');
      this.newType.set('text');
      // Show it in its new place straight away; the page reloads the saved order too.
      const keys = this.columns().map((c) => c.key);
      keys.splice(this.newAfter() ? keys.indexOf(this.newAfter()) + 1 : 0, 0, customKey(field as CustomField));
      this.localOrder.set(keys);
    });
  }

  startRename(field: CustomField) {
    this.editingId.set(field.id);
    this.editLabel.set(field.label);
    this.error.set('');
  }

  rename(field: CustomField) {
    const label = this.editLabel().trim();
    if (!label || label === field.label) return this.editingId.set(null);
    this.run(this.api.renameField(field.id, label), () => this.editingId.set(null));
  }

  remove() {
    const field = this.removing();
    if (!field) return;
    this.run(this.api.deleteField(field.id), () => this.removing.set(null), () => this.removing.set(null));
  }

  private run<T>(request: Observable<T>, done: (result: T) => void, failed?: () => void) {
    this.busy.set(true);
    this.error.set('');
    request.subscribe({
      next: (result) => {
        this.busy.set(false);
        done(result);
        this.changed.emit();
      },
      error: (err) => {
        this.busy.set(false);
        failed?.();
        this.error.set(errorMessage(err));
      },
    });
  }

  close() {
    this.dialogEl().nativeElement.close();
  }
}
