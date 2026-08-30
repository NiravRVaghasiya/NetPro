import type { Config } from 'tailwindcss';
import sharedPreset from '@netpro/config/tailwind';

const config: Config = {
  presets: [sharedPreset],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
};

export default config;
