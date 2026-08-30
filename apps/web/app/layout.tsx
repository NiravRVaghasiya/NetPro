import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'NetPro',
  description: 'Your professional network, owned by you.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
