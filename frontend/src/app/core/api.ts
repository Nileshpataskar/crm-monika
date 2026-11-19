import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  ColumnOrders, CustomField, Dashboard, DeleteResult, Entity, FieldType, Firm, FirmInput, FirmSummary, Order, Period, Quotation, Role, Upload, UploadPlan, UploadResult, UploadView, User, WorkLocation,
} from './models';

// "/api" is forwarded to FastAPI by proxy.conf.json during development, so no CORS setup is needed.
const API = '/api';

/** One place for every backend call. Components never build URLs themselves. */
@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  /** All active firms together, or one firm. */
  dashboard(firm?: number | null) {
    return this.http.get<Dashboard>(`${API}/dashboard`, { params: firm ? { firm } : {} });
  }

  // ----- firms -----
  firms() {
    return this.http.get<Firm[]>(`${API}/firms`);
  }

  firmsSummary() {
    return this.http.get<FirmSummary[]>(`${API}/firms/summary`);
  }

  saveFirm(body: FirmInput, id?: number) {
    return id ? this.http.patch<Firm>(`${API}/firms/${id}`, body) : this.http.post<Firm>(`${API}/firms`, body);
  }

  moveFirm(id: number, direction: 'up' | 'down') {
    return this.http.post<Firm[]>(`${API}/firms/${id}/move`, { direction });
  }

  deleteFirm(id: number) {
    return this.http.delete<{ deleted: number }>(`${API}/firms/${id}`);
  }

  orders(firm: number) {
    return this.http.get<Order[]>(`${API}/orders`, { params: { firm } });
  }

  quotations(firm: number) {
    return this.http.get<Quotation[]>(`${API}/quotations`, { params: { firm } });
  }

  uploads() {
    return this.http.get<Upload[]>(`${API}/uploads`);
  }

  // ----- single rows (admin) -----
  saveOrder(body: Record<string, unknown>, id?: number) {
    return id ? this.http.patch<Order>(`${API}/orders/${id}`, body) : this.http.post<Order>(`${API}/orders`, body);
  }

  saveQuotation(body: Record<string, unknown>, id?: number) {
    return id
      ? this.http.patch<Quotation>(`${API}/quotations/${id}`, body)
      : this.http.post<Quotation>(`${API}/quotations`, body);
  }

  deleteRow(entity: Entity, id: number) {
    return this.http.delete<{ deleted: number; from_excel: boolean }>(`${API}/${entity}/${id}`);
  }

  // ----- custom columns -----
  fields() {
    return this.http.get<CustomField[]>(`${API}/fields`);
  }

  /** after: the column key it goes after ('' = first). */
  createField(entity: Entity, label: string, type: FieldType, after: string) {
    return this.http.post<CustomField>(`${API}/fields`, { entity, label, type, after });
  }

  renameField(id: number, label: string) {
    return this.http.patch<CustomField>(`${API}/fields/${id}`, { label });
  }

  deleteField(id: number) {
    return this.http.delete<{ deleted: number; values_removed: number }>(`${API}/fields/${id}`);
  }

  // ----- column order -----
  columns() {
    return this.http.get<ColumnOrders>(`${API}/columns`);
  }

  saveColumns(entity: Entity, columns: string[]) {
    return this.http.put<string[]>(`${API}/columns/${entity}`, { columns });
  }

  // ----- work locations -----
  locations() {
    return this.http.get<WorkLocation[]>(`${API}/locations`);
  }

  addLocation(name: string) {
    return this.http.post<WorkLocation[]>(`${API}/locations`, { name });
  }

  deleteLocation(id: number) {
    return this.http.delete<WorkLocation[]>(`${API}/locations/${id}`);
  }

  /** One firm's orders, quotations or both as an Excel backup (a Blob). */
  exportExcel(entity: Entity | 'all', firm: number) {
    return this.http.get(`${API}/export`, { params: { entity, firm }, responseType: 'blob', observe: 'response' });
  }

  periods() {
    return this.http.get<Period[]>(`${API}/periods`);
  }

  /** Dry run: the server checks the file and says what would happen. Nothing is saved. */
  previewUpload(file: File, firm: number) {
    return this.http.post<UploadPlan>(`${API}/upload/preview`, fileForm(file, firm));
  }

  uploadExcel(file: File, firm: number) {
    return this.http.post<UploadResult>(`${API}/upload`, fileForm(file, firm));
  }

  viewUpload(id: number) {
    return this.http.get<UploadView>(`${API}/uploads/${id}/view`);
  }

  /** The original Excel file, as raw bytes (a Blob). */
  downloadUpload(id: number) {
    return this.http.get(`${API}/uploads/${id}/file`, { responseType: 'blob' });
  }

  /** dryRun = true only reports what would be deleted. */
  deleteUpload(id: number, dryRun: boolean) {
    return this.http.delete<DeleteResult>(`${API}/uploads/${id}`, { params: { dry_run: dryRun } });
  }

  deletePeriod(firm: number, type: string, period: string, dryRun: boolean) {
    return this.http.delete<DeleteResult>(`${API}/periods/${firm}/${type}/${period}`, { params: { dry_run: dryRun } });
  }

  users() {
    return this.http.get<User[]>(`${API}/users`);
  }

  createUser(body: { username: string; full_name: string; password: string; role: Role }) {
    return this.http.post<User>(`${API}/users`, body);
  }

  updateUser(id: number, body: Partial<{ full_name: string; role: Role; is_active: boolean; password: string }>) {
    return this.http.patch<User>(`${API}/users/${id}`, body);
  }
}

function fileForm(file: File, firm: number) {
  const form = new FormData();
  form.append('file', file);
  form.append('firm_id', String(firm));
  return form;
}

/** FastAPI puts error messages in `detail`. */
export function errorMessage(err: any, fallback = 'Something went wrong. Please try again.'): string {
  const detail = err?.error?.detail;
  if (typeof detail === 'string') return detail;
  // 0 = no response at all; 502/503/504 = the dev proxy couldn't reach FastAPI.
  if ([0, 502, 503, 504].includes(err?.status)) return 'Cannot reach the server. Is the backend running?';
  return fallback;
}
