import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  CustomField, Dashboard, DeleteResult, Entity, FieldType, Order, Period, Quotation, Role, Upload, UploadPlan, UploadResult,
  UploadView, User,
} from './models';

// "/api" is forwarded to FastAPI by proxy.conf.json during development, so no CORS setup is needed.
const API = '/api';

/** One place for every backend call. Components never build URLs themselves. */
@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  dashboard() {
    return this.http.get<Dashboard>(`${API}/dashboard`);
  }

  orders() {
    return this.http.get<Order[]>(`${API}/orders`);
  }

  quotations() {
    return this.http.get<Quotation[]>(`${API}/quotations`);
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

  createField(entity: Entity, label: string, type: FieldType) {
    return this.http.post<CustomField>(`${API}/fields`, { entity, label, type });
  }

  renameField(id: number, label: string) {
    return this.http.patch<CustomField>(`${API}/fields/${id}`, { label });
  }

  deleteField(id: number) {
    return this.http.delete<{ deleted: number; values_removed: number }>(`${API}/fields/${id}`);
  }

  /** Excel backup of orders, quotations or both, as a Blob. */
  exportExcel(entity: Entity | 'all') {
    return this.http.get(`${API}/export`, { params: { entity }, responseType: 'blob', observe: 'response' });
  }

  periods() {
    return this.http.get<Period[]>(`${API}/periods`);
  }

  /** Dry run: the server checks the file and says what would happen. Nothing is saved. */
  previewUpload(file: File) {
    return this.http.post<UploadPlan>(`${API}/upload/preview`, fileForm(file));
  }

  uploadExcel(file: File) {
    return this.http.post<UploadResult>(`${API}/upload`, fileForm(file));
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

  deletePeriod(type: string, period: string, dryRun: boolean) {
    return this.http.delete<DeleteResult>(`${API}/periods/${type}/${period}`, { params: { dry_run: dryRun } });
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

function fileForm(file: File) {
  const form = new FormData();
  form.append('file', file);
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
