import { defineConfig } from 'vite';

const worker = 'http://127.0.0.1:8787';
// The local Worker checks canonical Host and Origin. In development only,
// forward same-origin browser requests through the Vite proxy with its origin.
export default defineConfig({
  root: 'web',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: worker,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request, incoming) => {
            if (incoming.headers.origin) request.setHeader('Origin', worker);
          });
        },
      },
    },
  },
});
