import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, firstValueFrom, tap, throwError } from 'rxjs';
import { LoginResponse, User } from './models';

const TOKEN_KEY = 'crm_token';

/**
 * Keeps track of who is logged in. The JWT token is saved in localStorage so a page refresh
 * keeps you logged in. (For production, an httpOnly cookie is safer against XSS.)
 */
@Injectable({ providedIn: 'root' })
export class Auth {
  private http = inject(HttpClient);
  private router = inject(Router);

  readonly token = signal<string | null>(localStorage.getItem(TOKEN_KEY));
  readonly user = signal<User | null>(null);
  readonly isLoggedIn = computed(() => this.user() !== null);
  readonly isAdmin = computed(() => this.user()?.role === 'admin');

  login(username: string, password: string) {
    // OAuth2 login forms are sent as form fields, not JSON.
    const body = new URLSearchParams({ username, password });
    return this.http
      .post<LoginResponse>('/api/auth/login', body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      .pipe(
        tap((res) => {
          localStorage.setItem(TOKEN_KEY, res.access_token);
          this.token.set(res.access_token);
          this.user.set(res.user);
        }),
      );
  }

  logout() {
    localStorage.removeItem(TOKEN_KEY);
    this.token.set(null);
    this.user.set(null);
    this.router.navigate(['/login']);
  }

  /** Runs once when the app starts: if we have a saved token, find out who it belongs to. */
  async restoreSession() {
    if (!this.token()) return;
    try {
      this.user.set(await firstValueFrom(this.http.get<User>('/api/auth/me')));
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      this.token.set(null);
    }
  }
}

/** Adds "Authorization: Bearer <token>" to every API request, and logs out if the server says 401. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(Auth);
  const token = auth.token();
  const request = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;
  return next(request).pipe(
    catchError((err: HttpErrorResponse) => {
      const isLogin = req.url.endsWith('/auth/login') || req.url.endsWith('/auth/me');
      if (err.status === 401 && !isLogin) auth.logout();
      return throwError(() => err);
    }),
  );
};

/** Route guard: only logged-in users get in, everyone else goes to /login. */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(Auth);
  if (auth.isLoggedIn()) return true;
  return inject(Router).createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};

/** Route guard for admin-only pages. */
export const adminGuard: CanActivateFn = () => {
  const auth = inject(Auth);
  return auth.isAdmin() ? true : inject(Router).createUrlTree(['/dashboard']);
};
