// Bambook — electron-vite three-entry config.
//
// Layout:
//   electron/main.ts    → main process       → out/main/index.cjs   (CJS)
//   electron/preload.ts → preload bridge      → out/preload/index.cjs (CJS)
//   index.html (root)   → renderer (Bambook UI) → out/renderer/      (ESM)
//
// The renderer config delegates to the existing `vite.config.ts` so the web
// (`npm run dev`/`npm run build`) and Electron pipelines stay byte-identical
// for plugins, aliases, manualChunks and mocks. Any future tweak to the web
// build automatically propagates here with zero duplication.
//
// Note on shape: electron-vite's `renderer` slot must be a plain
// UserConfig object (it gets vite-mergeConfig'd internally and that helper
// rejects callbacks). Conversely vite.config.ts is a callback that needs
// {mode, command}. We bridge by making the *outer* electron-vite config a
// callback so we can eagerly resolve vite.config.ts with the correct env
// before handing the result back as a plain object.

import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import path from 'node:path';
import fs from 'node:fs';
import webViteConfig from './vite.config';

const BAMBOOK_UI_LAB_ELECTRON_FLAG = 'BAMBOOK_ELECTRON_UI_LAB';
const BAMBOOK_ELECTRON_RENDERER_PORT = 3000;
const BAMBOOK_UI_LAB_ELECTRON_RENDERER_PORT = 3100;

// Force out/main and out/preload to be parsed as CommonJS regardless of the
// root package.json type. We can't just use a .cjs extension because Electron
// 41 refuses to treat a .cjs main entry as the *main process* — it spawns the
// file as a plain Node script instead, leaving `require('electron')` returning
// the binary path string. A nested package.json with "type":"commonjs" lets us
// keep the .js extension (which Electron is happy to use as main entry) while
// still loading the file with Node's CJS loader.
//
// Vite plugin: writes the marker after each main/preload build pass.
const writeCjsMarker = (dir: string) => ({
    name: 'bambook:cjs-package-marker',
    closeBundle() {
        const target = path.resolve(__dirname, dir);
        if (!fs.existsSync(target)) return;
        fs.writeFileSync(
            path.join(target, 'package.json'),
            JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
        );
    },
});

export default defineConfig((async (env) => {
    const resolvedRenderer = typeof webViteConfig === 'function'
        ? await webViteConfig({ mode: env.mode, command: env.command as 'build' | 'serve' })
        : webViteConfig;
    const rendererPort = process.env[BAMBOOK_UI_LAB_ELECTRON_FLAG] === '1'
        ? BAMBOOK_UI_LAB_ELECTRON_RENDERER_PORT
        : BAMBOOK_ELECTRON_RENDERER_PORT;

    return {
        main: {
            // externalizeDepsPlugin keeps node-only deps (electron, fs, etc.)
            // out of the bundle and lets Node resolve them at runtime —
            // required for native modules like better-sqlite3 (added in B3).
            plugins: [externalizeDepsPlugin(), writeCjsMarker('out/main')],
            build: {
                outDir: 'out/main',
                lib: {
                    entry: path.resolve(__dirname, 'electron/main.ts'),
                    formats: ['cjs'],
                },
                rollupOptions: {
                    output: {
                        format: 'cjs',
                        // .js (not .cjs): Electron 41 only treats .js as a
                        // main-process entry. The nested package.json written
                        // by writeCjsMarker forces CJS parsing.
                        entryFileNames: 'main.js',
                    },
                },
            },
        },
        preload: {
            plugins: [externalizeDepsPlugin(), writeCjsMarker('out/preload')],
            build: {
                outDir: 'out/preload',
                lib: {
                    entry: path.resolve(__dirname, 'electron/preload.ts'),
                    formats: ['cjs'],
                },
                rollupOptions: {
                    output: {
                        format: 'cjs',
                        entryFileNames: 'preload.js',
                    },
                },
            },
        },
        renderer: {
            ...resolvedRenderer,
            server: {
                ...(resolvedRenderer.server ?? {}),
                port: rendererPort,
                strictPort: true,
                // 显式配置 HMR：electron-vite 在 dev 模式下用 loadURL 加载
                // http://localhost:PORT，HMR client 需要明确知道 WS 连到哪。
                // 不配 hmr 时 Vite 会自动推断，但在 Electron 环境中有时推断错误。
                hmr: {
                    host: 'localhost',
                    port: rendererPort,
                    protocol: 'ws',
                },
                // watch 配置确保前端文件变更被正确探测
                watch: {
                    usePolling: false,
                    interval: 100,
                },
            },
            // electron-vite expects renderer source rooted somewhere it can
            // find index.html — our index.html is at the project root.
            root: path.resolve(__dirname),
            // base './' so chunk and asset URLs in the built index.html use
            // RELATIVE paths. Electron loads renderer via the file:// protocol
            // where a leading '/' resolves to the OS root (not the document
            // directory), which breaks every absolute-rooted URL.
            base: './',
            build: {
                ...(resolvedRenderer.build ?? {}),
                outDir: 'out/renderer',
                emptyOutDir: true,
                rollupOptions: {
                    ...((resolvedRenderer.build ?? {}).rollupOptions ?? {}),
                    // Required by electron-vite — it does not auto-discover
                    // index.html the way `vite build` does at the project root.
                    input: {
                        main: path.resolve(__dirname, 'index.html'),
                    },
                },
            },
        },
    };
}) as any);
