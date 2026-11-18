import { Routes } from '@angular/router';
import { adminGuard, authGuard } from './core/auth';
import { Shell } from './layout/shell';

// loadComponent = lazy loading: each page's code is only downloaded when you first open it.
export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login/login').then((m) => m.Login) },
  {
    path: '',
    component: Shell,
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', title: 'Dashboard', loadComponent: () => import('./pages/dashboard/dashboard').then((m) => m.DashboardPage) },
      { path: 'orders', title: 'Orders', loadComponent: () => import('./pages/orders/orders').then((m) => m.OrdersPage) },
      { path: 'quotations', title: 'Quotations', loadComponent: () => import('./pages/quotations/quotations').then((m) => m.QuotationsPage) },
      { path: 'data', title: 'Data files', loadComponent: () => import('./pages/data-files/data-files').then((m) => m.DataFilesPage) },
      { path: 'users', title: 'Users', canActivate: [adminGuard], loadComponent: () => import('./pages/users/users').then((m) => m.UsersPage) },
    ],
  },
  { path: '**', redirectTo: '' },
];
