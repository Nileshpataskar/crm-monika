import { Injectable, signal } from '@angular/core';

/**
 * Opens and closes the upload modal from anywhere (top bar, dashboard, empty states).
 * The modal itself lives once in the shell.
 */
@Injectable({ providedIn: 'root' })
export class UploadDialog {
  readonly isOpen = signal(false);

  /** Goes up by one whenever data changes (import or delete). Pages read it in an effect to reload. */
  readonly version = signal(0);

  open() {
    this.isOpen.set(true);
  }

  close() {
    this.isOpen.set(false);
  }

  dataChanged() {
    this.version.update((v) => v + 1);
  }
}
