import type { NextConfig } from 'next';
const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingExcludes: {
    '*': ['.superpowers/**', '.env*', 'test-results/**', 'playwright-report/**', 'private-evidence/**'],
  },
};
export default config;
