'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Alert, Button, TextInput } from '@/components/ui/primitives';
import { loginAction, type LoginFormState } from './actions';

/**
 * The sign-in form.
 *
 * The only client component in the authentication flow, and it holds no credentials: the
 * form posts to a server action which sets an HttpOnly cookie. There is no token in
 * `localStorage`, nothing in a client bundle to steal, and no authentication decision
 * made in the browser (CLAUDE.md §27, §33).
 */

const INITIAL: LoginFormState = {};

export function LoginForm({ next }: { readonly next?: string }) {
  const [state, formAction] = useActionState(loginAction, INITIAL);

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {next !== undefined && <input type="hidden" name="next" value={next} />}

      {state.error !== undefined && <Alert tone="danger">{state.error}</Alert>}

      <div className="space-y-1.5">
        <label htmlFor="email" className="block text-[13px] font-medium text-text-primary">
          Email
        </label>
        <TextInput
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          defaultValue={state.email ?? ''}
          aria-invalid={state.error !== undefined}
          placeholder="you@company.com"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="password" className="block text-[13px] font-medium text-text-primary">
          Password
        </label>
        <TextInput
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={state.error !== undefined}
        />
      </div>

      <SubmitButton />
    </form>
  );
}

/**
 * `useFormStatus` must be read from a child of the form, which is why this is separate.
 * The button states exactly what it does and what it is doing (CLAUDE.md §21).
 */
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
  );
}
