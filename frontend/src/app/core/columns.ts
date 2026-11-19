import { CustomField, Entity } from './models';

/**
 * The columns of the Orders and Quotations tables. The admin can put them in any order and slot
 * custom columns in anywhere. The order is saved on the server as a list of keys: built-in columns
 * by name, custom ones as "custom:<id>" (by id, so renaming a column keeps its place).
 * Keys must match BUILT_IN_COLUMNS in backend/app/records.py.
 */
export const BUILT_IN_COLUMNS: Record<Entity, { key: string; label: string }[]> = {
  orders: [
    { key: 'order_date', label: 'Order date' },
    { key: 'customer', label: 'Customer' },
    { key: 'vendor_code', label: 'Vendor code' },
    { key: 'po_number', label: 'PO number' },
    { key: 'description', label: 'Description' },
    { key: 'invoice', label: 'Invoice' },
    { key: 'total_amount', label: 'Amount' },
    { key: 'status', label: 'Status' },
  ],
  quotations: [
    { key: 'quote_number', label: 'Quote' },
    { key: 'work_title', label: 'Work' },
    { key: 'work_location', label: 'Location' },
    { key: 'total_amount', label: 'Quoted' },
    { key: 'po_number', label: 'PO' },
    { key: 'status', label: 'Status' },
  ],
};

export interface TableColumn {
  key: string;
  label: string;
  custom?: CustomField; // set for an admin-defined column
}

export const customKey = (field: CustomField) => `custom:${field.id}`;

/** The table's columns in the saved order. Anything the saved order doesn't mention goes before Status. */
export function tableColumns(entity: Entity, order: string[], custom: CustomField[]): TableColumn[] {
  const all = new Map<string, TableColumn>();
  for (const c of BUILT_IN_COLUMNS[entity]) all.set(c.key, c);
  for (const f of custom.filter((f) => f.entity === entity)) all.set(customKey(f), { key: customKey(f), label: f.label, custom: f });

  const keys = order.filter((k) => all.has(k));
  const missing = [...all.keys()].filter((k) => !keys.includes(k) && k !== 'status');
  const status = keys.indexOf('status');
  if (status === -1) keys.push(...missing, 'status');
  else keys.splice(status, 0, ...missing);
  return keys.map((k) => all.get(k)!);
}
