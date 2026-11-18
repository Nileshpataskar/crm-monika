import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';
import { ThemeToggle } from '../../shared/theme-toggle';

@Component({
  selector: 'app-login',
  imports: [FormsModule, ThemeToggle],
  templateUrl: './login.html',
})
export class Login {
  private auth = inject(Auth);
  private router = inject(Router);

  /** Filled from ?returnUrl=... in the address bar (withComponentInputBinding in app.config). */
  readonly returnUrl = input<string>();

  protected username = signal('');
  protected password = signal('');
  protected showPassword = signal(false);
  protected loading = signal(false);
  protected error = signal('');

  constructor() {
    if (this.auth.isLoggedIn()) this.router.navigate(['/dashboard']);
  }

  submit() {
    if (!this.username() || !this.password()) {
      this.error.set('Enter your username and password.');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.auth.login(this.username(), this.password()).subscribe({
      next: () => this.router.navigateByUrl(this.returnUrl() || '/dashboard'),
      error: (err) => {
        this.error.set(errorMessage(err, 'Login failed.'));
        this.loading.set(false);
      },
    });
  }
}
