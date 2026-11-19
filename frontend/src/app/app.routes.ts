import { Routes } from '@angular/router';
import { adminGuard, authGuard } from './core/auth';
import { toFirstFirm } from './core/firms';
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
      // :firm = the firm's id. The page gets it as its `firm` input (withComponentInputBinding).
      { path: 'orders/:firm', title: 'Orders', loadComponent: () => import('./pages/orders/orders').then((m) => m.OrdersPage) },
      { path: 'quotations/:firm', title: 'Quotations', loadComponent: () => import('./pages/quotations/quotations').then((m) => m.QuotationsPage) },
      // No firm in the address: the guard sends you on to the first active firm.
      { path: 'orders', pathMatch: 'full', canActivate: [toFirstFirm('orders')], children: [] },
      { path: 'quotations', pathMatch: 'full', canActivate: [toFirstFirm('quotations')], children: [] },
      { path: 'firms', title: 'Firms', loadComponent: () => import('./pages/firms/firms').then((m) => m.FirmsPage) },
      { path: 'data', title: 'Data files', loadComponent: () => import('./pages/data-files/data-files').then((m) => m.DataFilesPage) },
      { path: 'users', title: 'Users', canActivate: [adminGuard], loadComponent: () => import('./pages/users/users').then((m) => m.UsersPage) },
    ],
  },
  { path: '**', redirectTo: '' },
];
