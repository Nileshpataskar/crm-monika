import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';
import { Role, User } from '../../core/models';

@Component({
  selector: 'app-users',
  imports: [FormsModule],
  templateUrl: './users.html',
})
export class UsersPage {
  private api = inject(Api);
  protected auth = inject(Auth);

  protected users = signal<User[]>([]);
  protected loading = signal(true);
  protected error = signal('');
  protected notice = signal('');

  // "Add user" form
  protected showForm = signal(false);
  protected fullName = signal('');
  protected username = signal('');
  protected password = signal('');
  protected role = signal<Role>('viewer');
  protected saving = signal(false);

  // Row currently showing the "set new password" box
  protected resetFor = signal<number | null>(null);
  protected newPassword = signal('');

  protected formValid = computed(
    () => this.fullName().trim() && /^[a-z0-9._-]{3,}$/i.test(this.username().trim()) && this.password().length >= 8,
  );

  constructor() {
    this.load();
  }

  load() {
    this.api.users().subscribe({
      next: (rows) => {
        this.users.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  create() {
    if (!this.formValid()) return;
    this.saving.set(true);
    this.error.set('');
    this.api
      .createUser({ full_name: this.fullName(), username: this.username(), password: this.password(), role: this.role() })
      .subscribe({
        next: (user) => {
          this.notice.set(`Created ${user.full_name}. Share the username and password with them.`);
          this.fullName.set('');
          this.username.set('');
          this.password.set('');
          this.role.set('viewer');
          this.showForm.set(false);
          this.saving.set(false);
          this.load();
        },
        error: (err) => {
          this.error.set(errorMessage(err));
          this.saving.set(false);
        },
      });
  }

  update(user: User, change: Partial<{ role: Role; is_active: boolean; password: string }>, message: string) {
    this.error.set('');
    this.api.updateUser(user.id, change).subscribe({
      next: () => {
        this.notice.set(message);
        this.resetFor.set(null);
        this.newPassword.set('');
        this.load();
      },
      error: (err) => this.error.set(errorMessage(err)),
    });
  }

  isMe(user: User) {
    return user.id === this.auth.user()?.id;
  }
}
