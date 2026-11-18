import { Injectable, computed, effect, signal } from '@angular/core';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'crm_theme';
const ORDER: ThemeChoice[] = ['system', 'light', 'dark'];

/**
 * Light / dark mode. "system" follows the computer's setting. The choice is put on <html
 * data-theme="dark">, and styles.css swaps every colour token for that. A small script in
 * index.html does the same before Angular starts, so the page never flashes the wrong colours.
 */
@Injectable({ providedIn: 'root' })
export class Theme {
  readonly choice = signal<ThemeChoice>(this.saved());
  private media = matchMedia('(prefers-color-scheme: dark)');
  private systemDark = signal(this.media.matches);

  /** The theme actually showing. Charts read this so they redraw with the new colours. */
  readonly effective = computed<'light' | 'dark'>(() =>
    this.choice() === 'system' ? (this.systemDark() ? 'dark' : 'light') : (this.choice() as 'light' | 'dark'),
  );

  constructor() {
    this.media.addEventListener('change', (e) => this.systemDark.set(e.matches));
    effect(() => {
      document.documentElement.dataset['theme'] = this.effective();
    });
  }

  /** System → Light → Dark → System … */
  next() {
    const choice = ORDER[(ORDER.indexOf(this.choice()) + 1) % ORDER.length];
    this.choice.set(choice);
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      // private browsing: the choice just isn't remembered
    }
  }

  private saved(): ThemeChoice {
    try {
      const value = localStorage.getItem(KEY) as ThemeChoice | null;
      return value && ORDER.includes(value) ? value : 'system';
    } catch {
      return 'system';
    }
  }
}
