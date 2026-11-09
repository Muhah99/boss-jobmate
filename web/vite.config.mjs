import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],build:{outDir:'dist'},server:{host:'127.0.0.1',port:4321,strictPort:true,proxy:{'/api':'http://127.0.0.1:4320'}}});
