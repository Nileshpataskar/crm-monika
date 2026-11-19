// TypeScript shapes of what the FastAPI backend returns (see backend/app/models.py).

export type Role = 'admin' | 'viewer';

export interface User {
  id: number;
  username: string;
  full_name: string;
  role: Role;
  is_active: boolean;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user: User;
}

/** Values of the admin's custom columns, by key: { site_engineer: 'Ravi' } */
export type Extra = Record<string, string | number | boolean | null>;

/** One of the client's two firms. Every order, quotation and upload belongs to one. */
export interface Firm {
  id: number;
  name: string;
  position: number;
  gstin: string | null;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  archived_at: string | null; // set = archived: hidden from menus and the dashboard, data kept
}

/** The editable part of a firm, as sent by the firm form. `archived` archives / restores. */
export type FirmInput = Partial<Pick<Firm, 'name' | 'gstin' | 'contact_person' | 'phone' | 'email' | 'address' | 'notes'>> & {
  archived?: boolean;
};

/** Numbers for one firm on the Firms page. */
export interface FirmSummary {
  firm_id: number;
  orders: number;
  quotations: number;
  uploads: number;
  invoiced: number;
  received: number;
  outstanding: number;
  last_upload: string | null;
}

export interface Order {
  id: number;
  firm_id: number;
  upload_id: number | null; // null = typed into the app
  extra: Extra | null;
  sheet_name: string;
  period: string | null;
  excel_row: number;
  customer: string | null;
  order_date: string | null;
  vendor_code: string | null;
  po_number: string | null;
  po_email_received: boolean | null;
  description: string | null;
  qty: number | null;
  unit: string | null;
  category: string | null;
  delivery_location: string | null;
  indentor: string | null;
  quotation_number: string | null;
  delivery_date: string | null;
  dc_number: string | null;
  dc_received: boolean | null;
  invoice_date: string | null;
  invoice_number: string | null;
  jcc: string | null;
  amount: number | null;
  cgst: number | null;
  sgst: number | null;
  total_amount: number | null;
  print_stamp: boolean | null;
  grn_done: boolean | null;
  purchase_bill_received: boolean | null;
  payment_received: boolean | null;
}

export interface Quotation {
  id: number;
  firm_id: number;
  upload_id: number | null; // null = typed into the app
  extra: Extra | null;
  sheet_name: string;
  period: string | null;
  excel_row: number;
  work_location: string | null;
  quote_number: string | null;
  work_title: string | null;
  work_type: string | null;
  work_completed: boolean | null;
  work_date: string | null;
  indentor: string | null;
  total_amount: number | null;
  pr_number: string | null;
  booked: boolean | null;
  po_number: string | null;
  po_released: boolean | null;
  po_amount: number | null;
  print_stamp: boolean | null;
  invoice_number: string | null;
  grn_done: boolean | null;
  payment_received: boolean | null;
}

export interface Upload {
  id: number;
  firm_id: number | null;
  filename: string;
  uploaded_at: string;
  orders_imported: number;
  quotations_imported: number;
  has_file: boolean; // false for uploads made before files were kept
  periods: { type: 'orders' | 'quotations'; period: string; label: string; rows: number }[]; // data it still provides
}

/** What the server plans to do with one sheet of an uploaded workbook. */
export interface SheetPlan {
  sheet: string;
  type: 'orders' | 'quotations' | null;
  period: string | null;
  period_label: string | null; // "June 2026", "FY 2026-27"
  rows: number; // rows that will be imported
  existing_rows: number; // rows already stored for this month, which get replaced
  carried_over: { from: string; rows: number }[]; // older copies this upload updates
  skipped_newer: { in: string; rows: number }[]; // rows skipped because a newer month has them
  warnings: string[];
  errors: string[];
}

export interface UploadPlan {
  sheets: SheetPlan[];
  can_import: boolean;
  total_rows: number;
}

export interface UploadResult extends UploadPlan {
  upload_id: number;
}

export interface Period {
  type: 'orders' | 'quotations';
  firm_id: number;
  period: string;
  label: string;
  rows: number; // rows from Excel that are shown
  hidden: number; // older copies now shown under a later month instead
  manual: number; // rows typed into the app
  upload_id: number;
  filename: string | null;
}

/** An uploaded workbook as text, for the Excel viewer. */
export interface UploadView {
  id: number;
  filename: string;
  sheets: {
    name: string;
    type: 'orders' | 'quotations' | null;
    period_label: string | null;
    headers: string[];
    rows: { excel_row: number; cells: string[] }[];
    truncated?: boolean;
  }[];
}

/** What a delete removed, or would remove when dry_run is true. */
export interface DeleteResult {
  deleted: { type: 'orders' | 'quotations'; firm_id: number; period: string; label: string; rows: number; restored: { label: string; rows: number }[] }[];
  file_deleted?: boolean;
  dry_run: boolean;
}

export interface BriefOrder {
  id: number;
  firm_id: number;
  customer: string | null;
  po_number: string | null;
  dc_number: string | null;
  invoice_number: string | null;
  order_date: string | null;
  description: string | null;
}

export interface Dashboard {
  kpis: {
    orders: number;
    invoices: number;
    invoiced_total: number;
    received_total: number;
    outstanding_total: number;
    open_quotes: number;
    open_quotes_value: number;
    won_quotes: number;
    won_quotes_value: number;
  };
  by_customer: { customer: string; invoiced: number; received: number; outstanding: number }[];
  by_firm: FirmPayments[];
  by_category: { category: string; orders: number; invoiced: number }[];
  by_month: { month: string; invoiced: number }[];
  attention: {
    unpaid_invoices: {
      id: number;
      firm_id: number;
      customer: string | null;
      invoice_number: string | null;
      invoice_date: string | null;
      description: string | null;
      total_amount: number | null;
      days_pending: number | null;
    }[];
    to_invoice: BriefOrder[];
    dc_not_received: BriefOrder[];
    grn_pending: BriefOrder[];
  };
}

export type Entity = 'orders' | 'quotations';
export type FieldType = 'text' | 'number' | 'date' | 'yesno';

/** An extra column the admin added. Its values are in each row's `extra[key]`. */
export interface CustomField {
  id: number;
  entity: Entity;
  key: string;
  label: string;
  type: FieldType;
  position: number;
}

/** Payments of one firm, split by vendor code (the number each customer gave the firm). */
export interface FirmPayments {
  firm_id: number;
  name: string;
  invoiced: number;
  received: number;
  outstanding: number;
  vendors: {
    vendor_code: string | null;
    customers: string[];
    invoices: number;
    invoiced: number;
    received: number;
    outstanding: number;
  }[];
}

/** A work location for quotations. id is null for one that's only used by quotations, not in the list. */
export interface WorkLocation {
  id: number | null;
  name: string;
  quotations: number;
}

/** Column order per table: built-in column names and "custom:<id>" for custom columns. */
export type ColumnOrders = Record<Entity, string[]>;
