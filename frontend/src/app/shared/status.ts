import { Order, Quotation } from '../core/models';

/** Matches the .chip.good / .warning / .serious / .critical classes in styles.css. '' = neutral grey. */
export type Tone = 'good' | 'warning' | 'serious' | 'critical' | '';

export interface Status {
  label: string;
  tone: Tone;
}

export function paymentStatus(o: Pick<Order, 'invoice_number' | 'payment_received'>): Status {
  if (!o.invoice_number) return { label: 'Not invoiced', tone: '' };
  return o.payment_received ? { label: 'Paid', tone: 'good' } : { label: 'Unpaid', tone: 'serious' };
}

export function grnStatus(o: Pick<Order, 'invoice_number' | 'grn_done'>): Status | null {
  if (!o.invoice_number || o.grn_done === null) return null;
  return o.grn_done ? { label: 'GRN done', tone: 'good' } : { label: 'GRN pending', tone: 'warning' };
}

/** How long an invoice has been waiting for payment. */
export function agingStatus(days: number | null): Status {
  if (days === null) return { label: 'No date', tone: '' };
  const label = `${days} day${days === 1 ? '' : 's'}`;
  if (days > 90) return { label, tone: 'critical' };
  if (days > 60) return { label, tone: 'serious' };
  if (days > 30) return { label, tone: 'warning' };
  return { label, tone: '' };
}

export function quoteStatus(q: Quotation): Status {
  if (q.po_number) return { label: q.po_released === false ? 'PO not released' : 'PO received', tone: 'good' };
  return { label: 'Awaiting PO', tone: 'warning' };
}

export function workStatus(q: Quotation): Status {
  return q.work_completed ? { label: 'Completed', tone: 'good' } : { label: 'Not completed', tone: '' };
}
