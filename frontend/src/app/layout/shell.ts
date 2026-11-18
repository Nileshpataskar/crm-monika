import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Auth } from '../core/auth';
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

const NAV: NavGroup[] = [
  { title: 'Overview', items: [{ path: '/dashboard', label: 'Dashboard', icon: 'dashboard' }] },
  {
    title: 'Records',
    items: [
      { path: '/orders', label: 'Orders', icon: 'inventory_2' },
      { path: '/quotations', label: 'Quotations', icon: 'request_quote' },
      { path: '/data', label: 'Data files', icon: 'folder_open' },
    ],
  },
  {
    title: 'Admin',
    items: [
      { path: '/users', label: 'Users', icon: 'group', adminOnly: true },
    ],
  },
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
  protected menuOpen = signal(false); // only used on small screens
  protected today = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  /** Hide admin-only links from viewers, and drop groups that end up empty. */
  protected nav = computed(() =>
    NAV.map((group) => ({ ...group, items: group.items.filter((i) => !i.adminOnly || this.auth.isAdmin()) })).filter(
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
