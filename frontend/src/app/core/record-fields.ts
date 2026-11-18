import { CustomField, Entity, FieldType } from './models';

/** One input in the add/edit form. Field names match the backend (backend/app/excel_import.py). */
export interface FormField {
  key: string;
  label: string;
  type: FieldType | 'textarea';
  required?: boolean;
  /** Words shown for yes/no fields, matching the client's Excel dropdowns. Default: Yes / No. */
  yesNo?: [string, string];
  /** Offer earlier values as suggestions while typing (customers, categories, ...). */
  suggest?: boolean;
  hint?: string;
  wide?: boolean; // spans both columns
  custom?: boolean; // an admin-defined column, stored in `extra`
}

export interface FormSection {
  title: string;
  fields: FormField[];
}

const ORDER_SECTIONS: FormSection[] = [
  {
    title: 'Order',
    fields: [
      { key: 'customer', label: 'Customer', type: 'text', required: true, suggest: true },
      { key: 'order_date', label: 'Order date', type: 'date' },
      { key: 'description', label: 'Description', type: 'textarea', required: true, wide: true },
      { key: 'po_number', label: 'PR / PO number', type: 'text' },
      { key: 'vendor_code', label: 'Vendor code', type: 'text', suggest: true },
      { key: 'po_email_received', label: 'PO email received', type: 'yesno' },
      { key: 'quotation_number', label: 'Quotation number', type: 'text' },
      { key: 'category', label: 'Category', type: 'text', suggest: true },
      { key: 'delivery_location', label: 'Delivery location', type: 'text', suggest: true },
      { key: 'qty', label: 'Quantity', type: 'number' },
      { key: 'unit', label: 'Unit', type: 'text', suggest: true },
      { key: 'indentor', label: 'Indentor', type: 'text', suggest: true, wide: true },
    ],
  },
  {
    title: 'Delivery',
    fields: [
      { key: 'delivery_date', label: 'Delivery date', type: 'date' },
      { key: 'dc_number', label: 'DC number', type: 'text' },
      { key: 'dc_received', label: 'DC receipt', type: 'yesno', yesNo: ['Received', 'Not received'] },
    ],
  },
  {
    title: 'Invoice & payment',
    fields: [
      { key: 'invoice_number', label: 'Invoice number', type: 'text' },
      { key: 'invoice_date', label: 'Invoice date', type: 'date' },
      { key: 'jcc', label: 'JCC', type: 'text' },
      { key: 'amount', label: 'Amount (before GST)', type: 'number' },
      { key: 'cgst', label: 'CGST', type: 'number', hint: 'Leave empty for 9%' },
      { key: 'sgst', label: 'SGST', type: 'number', hint: 'Leave empty for 9%' },
      { key: 'print_stamp', label: 'Print + stamp', type: 'yesno' },
      { key: 'grn_done', label: 'GRN', type: 'yesno', yesNo: ['Complete', 'Incomplete'] },
      { key: 'purchase_bill_received', label: 'Purchase bill received', type: 'yesno' },
      { key: 'payment_received', label: 'Payment received in bank', type: 'yesno' },
    ],
  },
];

const QUOTATION_SECTIONS: FormSection[] = [
  {
    title: 'Quotation',
    fields: [
      { key: 'work_title', label: 'Work title', type: 'textarea', required: true, wide: true },
      { key: 'quote_number', label: 'Quote number', type: 'text' },
      { key: 'work_date', label: 'Work date', type: 'date' },
      { key: 'work_location', label: 'Work location', type: 'text', suggest: true },
      { key: 'work_type', label: 'Work type', type: 'text', suggest: true },
      { key: 'indentor', label: 'Indentor', type: 'text', suggest: true },
      { key: 'total_amount', label: 'Quoted amount', type: 'number' },
      { key: 'work_completed', label: 'Work status', type: 'yesno', yesNo: ['Completed', 'Not completed'] },
    ],
  },
  {
    title: 'PO & billing',
    fields: [
      { key: 'pr_number', label: 'PR number', type: 'text' },
      { key: 'booked', label: 'Booked', type: 'yesno', yesNo: ['Yes', 'Not yet'] },
      { key: 'po_number', label: 'PO number', type: 'text' },
      { key: 'po_released', label: 'PO status', type: 'yesno', yesNo: ['Released', 'Not released'] },
      { key: 'po_amount', label: 'PO amount', type: 'number' },
      { key: 'invoice_number', label: 'Invoice number', type: 'text' },
      { key: 'print_stamp', label: 'Print + stamp', type: 'yesno' },
      { key: 'grn_done', label: 'GRN', type: 'yesno' },
      { key: 'payment_received', label: 'Money received in bank', type: 'yesno' },
    ],
  },
];

/** The built-in sections, plus a section for the admin's custom columns if there are any. */
export function formSections(entity: Entity, custom: CustomField[]): FormSection[] {
  const sections = entity === 'orders' ? ORDER_SECTIONS : QUOTATION_SECTIONS;
  const extra = custom.filter((f) => f.entity === entity);
  if (!extra.length) return sections;
  return [
    ...sections,
    { title: 'More details', fields: extra.map((f) => ({ key: f.key, label: f.label, type: f.type, custom: true })) },
  ];
}

/** How a custom column's value is shown in tables and the detail panel. */
export function formatExtra(field: CustomField, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'yesno') return value ? 'Yes' : 'No';
  if (field.type === 'date') return new Date(String(value)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  if (field.type === 'number') return Number(value).toLocaleString('en-IN');
  return String(value);
}
