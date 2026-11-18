import { Component, ElementRef, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { Observable } from 'rxjs';
import { Api, errorMessage } from '../core/api';
import { CustomField, Entity, FieldType } from '../core/models';
import { ConfirmDialog } from './confirm-dialog';

const TYPES: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'yesno', label: 'Yes / No' },
];

/** Admin: add, rename and remove custom columns for Orders or Quotations. */
@Component({
  selector: 'app-columns-dialog',
  imports: [ConfirmDialog],
  templateUrl: './columns-dialog.html',
})
export class ColumnsDialog {
  private api = inject(Api);

  readonly entity = input.required<Entity>();
  readonly fields = input.required<CustomField[]>();
  /** Something changed: the page reloads its columns and rows. */
  readonly changed = output<void>();
  readonly closed = output<void>();

  private dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('dialogEl');

  protected types = TYPES;
  protected newLabel = signal('');
  protected newType = signal<FieldType>('text');
  protected editingId = signal<number | null>(null);
  protected editLabel = signal('');
  protected removing = signal<CustomField | null>(null);
  protected busy = signal(false);
  protected error = signal('');

  protected mine = computed(() => this.fields().filter((f) => f.entity === this.entity()));
  protected noun = computed(() => (this.entity() === 'orders' ? 'Orders' : 'Quotations'));

  constructor() {
    afterNextRender(() => this.dialogEl().nativeElement.showModal());
  }

  typeLabel(type: FieldType) {
    return TYPES.find((t) => t.value === type)?.label ?? type;
  }

  add() {
    const label = this.newLabel().trim();
    if (!label) return this.error.set('Type a name for the new column.');
    this.run(this.api.createField(this.entity(), label, this.newType()), () => {
      this.newLabel.set('');
      this.newType.set('text');
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

  private run(request: Observable<unknown>, done: () => void, failed?: () => void) {
    this.busy.set(true);
    this.error.set('');
    request.subscribe({
      next: () => {
        this.busy.set(false);
        done();
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
