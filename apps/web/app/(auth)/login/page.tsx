import { signIn } from '@/lib/auth';

export default function LoginPage() {
  return (
    <div>
      <h1>Sign in to NetPro</h1>
      <form
        action={async () => {
          'use server';
          await signIn('github');
        }}
      >
        <button type="submit">Continue with GitHub</button>
      </form>
    </div>
  );
}
