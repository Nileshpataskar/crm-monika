import { Component, inject } from '@angular/core';
import { NavigationCancel, NavigationEnd, NavigationError, NavigationStart, Router, RouterOutlet } from '@angular/router';
import { Loading } from './core/loading';
import { Theme } from './core/theme';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `
    <!-- Thin bar along the top while anything is loading -->
    <div class="fixed inset-x-0 top-0 z-[60] h-[3px] overflow-hidden pointer-events-none transition-opacity duration-300"
         [class.opacity-0]="!loading.busy()" aria-hidden="true">
      <div class="loading-bar h-full w-1/3 rounded-full bg-accent"></div>
    </div>

    @if (loading.slow()) {
      <div class="fixed bottom-5 left-1/2 -translate-x-1/2 z-[70] card flex items-center gap-3 px-4 py-3 shadow-lg max-w-[calc(100vw-32px)]"
           role="status" aria-live="polite">
        <span class="spinner !size-5 text-accent"></span>
        <span class="text-[13px]">
          <b>Waking up the server…</b>
          <span class="text-ink-2"> After a quiet spell the first request takes a few seconds.</span>
        </span>
      </div>
    }

    <router-outlet />
  `,
})
export class App {
  protected loading = inject(Loading);
  private theme = inject(Theme); // created here so the chosen theme is applied from the start

  constructor() {
    // Opening a page for the first time downloads its code, so count page changes as loading too.
    inject(Router).events.subscribe((event) => {
      if (event instanceof NavigationStart) this.loading.start();
      if (event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError) {
        this.loading.stop();
      }
    });
  }
}
