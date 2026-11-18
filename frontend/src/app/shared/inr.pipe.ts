import { Pipe, PipeTransform } from '@angular/core';

const full = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Indian rupee formatting with lakh grouping: {{ 196756.46 | inr }} -> ₹1,96,756.46 */
@Pipe({ name: 'inr' })
export class InrPipe implements PipeTransform {
  transform(value: number | null | undefined, style: 'full' | 'whole' | 'compact' = 'full'): string {
    if (value === null || value === undefined) return '—';
    return { full, whole, compact }[style].format(value);
  }
}

export const formatInr = (value: number, style: 'full' | 'whole' | 'compact' = 'full') =>
  new InrPipe().transform(value, style);
