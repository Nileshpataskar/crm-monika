import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { Auth, authInterceptor } from './core/auth';
import { loadingInterceptor } from './core/loading';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch(), withInterceptors([loadingInterceptor, authInterceptor])),
    // Before the first page shows, check whether a saved login token is still valid.
    provideAppInitializer(() => inject(Auth).restoreSession()),
  ],
};
