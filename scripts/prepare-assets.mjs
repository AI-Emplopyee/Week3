import { copyFileSync, mkdirSync } from 'node:fs';

// Rendering only: this self-hosted Wasm converts PDF pages to model input images.
mkdirSync('public/pdfium', { recursive: true });
copyFileSync('node_modules/@hyzyla/pdfium/dist/pdfium.wasm', 'public/pdfium/pdfium.wasm');
copyFileSync('node_modules/@hyzyla/pdfium/LICENSE.md', 'public/pdfium/LICENSE.md');
