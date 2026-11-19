import { Injectable, computed, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Observable, map, tap } from 'rxjs';
import { Api } from './api';
import { Firm, FirmInput } from './models';

/** The firms, loaded once and shared by the menu, the pages and the upload window. */
@Injectable({ providedIn: 'root' })
export class Firms {
  private api = inject(Api);
  /** Every firm, archived ones too, in menu order. */
  readonly list = signal<Firm[]>([]);
  /** The firms in use: shown in the menu, the upload window and the dashboard. */
  readonly active = computed(() => this.list().filter((f) => !f.archived_at));
  private byId = computed(() => new Map(this.list().map((f) => [f.id, f])));

  load() {
    this.api.firms().subscribe((firms) => this.list.set(firms));
  }

  get(id: number | null | undefined): Firm | undefined {
    return id != null ? this.byId().get(id) : undefined;
  }

  name(id: number | null | undefined): string {
    return this.get(id)?.name ?? 'Unknown firm';
  }

  /** Add (no id) or edit a firm; the menu updates straight away. */
  save(body: FirmInput, id?: number): Observable<Firm> {
    return this.api.saveFirm(body, id).pipe(
      tap((firm) =>
        this.list.update((list) => (id ? list.map((f) => (f.id === firm.id ? firm : f)) : [...list, firm])),
      ),
    );
  }

  rename(id: number, name: string): Observable<Firm> {
    return this.save({ name }, id);
  }

  move(id: number, direction: 'up' | 'down'): Observable<Firm[]> {
    return this.api.moveFirm(id, direction).pipe(tap((firms) => this.list.set(firms)));
  }

  remove(id: number): Observable<unknown> {
    return this.api.deleteFirm(id).pipe(tap(() => this.list.update((list) => list.filter((f) => f.id !== id))));
  }
}

/** /orders or /quotations without a firm: go to the first active firm's page (not a fixed id,
 *  since firms can be added, reordered, archived or deleted). */
export function toFirstFirm(page: 'orders' | 'quotations'): CanActivateFn {
  return () => {
    const router = inject(Router);
    return inject(Api).firms().pipe(
      map((firms) => {
        const first = firms.find((f) => !f.archived_at) ?? firms[0];
        return router.createUrlTree(first ? [`/${page}`, first.id] : ['/firms']);
      }),
    );
  };
}
