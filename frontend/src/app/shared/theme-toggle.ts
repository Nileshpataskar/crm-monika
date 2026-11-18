import { Component, computed, inject } from '@angular/core';
import { Theme } from '../core/theme';

const LOOK = {
  system: { icon: 'brightness_auto', label: 'System' },
  light: { icon: 'light_mode', label: 'Light' },
  dark: { icon: 'dark_mode', label: 'Dark' },
};

/** Round button that cycles System → Light → Dark. */
@Component({
  selector: 'app-theme-toggle',
  template: `
    <button type="button" class="grid place-items-center size-9 rounded-full border border-line bg-surface text-ink-2 hover:text-ink hover:bg-surface-2 cursor-pointer"
            (click)="theme.next()" [title]="'Theme: ' + look().label + ' (click to change)'" [attr.aria-label]="'Theme: ' + look().label">
      <span class="icon !text-lg">{{ look().icon }}</span>
    </button>
  `,
})
export class ThemeToggle {
  protected theme = inject(Theme);
  protected look = computed(() => LOOK[this.theme.choice()]);
}
