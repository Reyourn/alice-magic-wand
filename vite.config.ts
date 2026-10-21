import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],server:{port:4311,proxy:{'/api':'http://127.0.0.1:4310'}},build:{outDir:'dist/public',emptyOutDir:false,rollupOptions:{input:{workbench:'index.html',universe:'universe.html'}}}});
