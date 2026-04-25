import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@operator-os/contracts': path.resolve(__dirname, 'src/contracts'),
      '@operator-os/config': path.resolve(__dirname, 'src/config')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx']
  }
});
