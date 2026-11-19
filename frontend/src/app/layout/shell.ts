import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { Auth } from '../core/auth';
import { Firms } from '../core/firms';
import { UploadDialog } from '../core/upload-dialog';
import { ThemeToggle } from '../shared/theme-toggle';
import { UploadModal } from '../shared/upload-modal';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const OVERVIEW: NavGroup = { title: 'Overview', items: [{ path: '/dashboard', label: 'Dashboard', icon: 'dashboard' }] };
const MORE: NavGroup[] = [
  {
    title: 'Records',
    items: [
      { path: '/firms', label: 'Firms', icon: 'apartment' },
      { path: '/data', label: 'Data files', icon: 'folder_open' },
    ],
  },
  { title: 'Admin', items: [{ path: '/users', label: 'Users', icon: 'group', adminOnly: true }] },
];

/** The frame around every logged-in page: sidebar on the left, top bar, then the page. */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, UploadModal, ThemeToggle],
  templateUrl: './shell.html',
})
export class Shell {
  protected auth = inject(Auth);
  protected upload = inject(UploadDialog);
  private firms = inject(Firms);
  private router = inject(Router);

  /** The firm whose page is open (/orders/2 -> 2), so Upload Excel starts with that firm chosen. */
  private url = toSignal(this.router.events.pipe(filter((e) => e instanceof NavigationEnd), map(() => this.router.url)),
    { initialValue: this.router.url });
  protected currentFirm = computed(() => {
    const match = this.url().match(/^\/(?:orders|quotations)\/(\d+)/);
    return match ? Number(match[1]) : null;
  });
  protected menuOpen = signal(false); // only used on small screens
  protected today = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  constructor() {
    this.firms.load();
  }

  /** A group per firm with its Orders and Quotations. Admin-only links hidden from viewers, empty groups dropped. */
  protected nav = computed(() =>
    ([
      OVERVIEW,
      ...this.firms.active().map((firm) => ({
        title: firm.name,
        items: [
          { path: `/orders/${firm.id}`, label: 'Orders', icon: 'inventory_2' },
          { path: `/quotations/${firm.id}`, label: 'Quotations', icon: 'request_quote' },
        ],
      })),
      ...MORE,
    ] as NavGroup[]).map((group) => ({ ...group, items: group.items.filter((i) => !i.adminOnly || this.auth.isAdmin()) })).filter(
      (group) => group.items.length,
    ),
  );

  protected initials = computed(() =>
    (this.auth.user()?.full_name ?? '?')
      .split(' ')
      .map((part) => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  );
}
