import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config.base.js';

export default mergeConfig(base, {
  resolve: {
    // The same "@/" alias tsconfig.json declares, so a test can import a
    // module that itself imports through the alias.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
