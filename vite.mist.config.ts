import { defineConfig, mergeConfig } from 'vite';
import referenceConfig from './dev-ui-preview/mist-atelier/app/vite.config';

// Both Mist ports run the same approved frontend source. Business adapters attach here.
export default defineConfig(
  mergeConfig(referenceConfig, {
    cacheDir: '/tmp/bambook-mist-runtime-cache',
    server: {
      port: 3001,
      host: '127.0.0.1',
      strictPort: true,
    },
    preview: { port: 4174, host: '127.0.0.1', strictPort: true },
  }),
);
