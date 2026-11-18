import { HttpInterceptorFn } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { finalize } from 'rxjs';

const SLOW_AFTER_MS = 2500;

/**
 * Counts what's loading right now (API requests and page changes), for the bar at the top of
 * the screen. If something takes longer than 2.5 s, `slow` turns on: the free server is waking up.
 */
@Injectable({ providedIn: 'root' })
export class Loading {
  private pending = signal(0);
  readonly busy = computed(() => this.pending() > 0);
  readonly slow = signal(false);
  private slowTimer: ReturnType<typeof setTimeout> | undefined;

  start() {
    this.pending.update((n) => n + 1);
    if (this.pending() === 1) {
      this.slowTimer = setTimeout(() => this.slow.set(true), SLOW_AFTER_MS);
    }
  }

  stop() {
    this.pending.update((n) => Math.max(0, n - 1));
    if (this.pending() === 0) {
      clearTimeout(this.slowTimer);
      this.slow.set(false);
    }
  }
}

/** Every API request counts as "loading" until it finishes, whether it worked or not. */
export const loadingInterceptor: HttpInterceptorFn = (req, next) => {
  const loading = inject(Loading);
  loading.start();
  return next(req).pipe(finalize(() => loading.stop()));
};
