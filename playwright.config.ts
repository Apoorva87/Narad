import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5179', channel: 'chrome', screenshot: 'only-on-failure' },
  outputDir: 'artifacts/test-results',
  webServer: [
    { command: 'npx tsx server/index.ts', url: 'http://127.0.0.1:4319/api/health', env: { NARAD_PORT: '4319', NARAD_DATA_DIR: mkdtempSync(join(tmpdir(), 'narad-browser-')) } },
    { command: 'npx vite --host 127.0.0.1 --port 5179 --strictPort', url: 'http://127.0.0.1:5179', env: { VITE_API_TARGET: 'http://127.0.0.1:4319' } },
  ],
});
