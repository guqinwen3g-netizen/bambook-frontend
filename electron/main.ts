// Bambook — Electron main process entry.
//
// Responsibilities at this stage (B1):
//   • Create a single BrowserWindow with hardened defaults.
//   • In dev, load the Vite dev server URL injected by electron-vite as
//     `process.env.ELECTRON_RENDERER_URL`.
//   • In prod, load the built renderer from `out/renderer/index.html`.
//   • Standard macOS lifecycle (re-create window on activate, quit on
//     window-all-closed except darwin).
//
// The Express backend (server/) and IPC handlers will be wired in B5/B8.
// This file deliberately stays minimal so the skeleton is auditable.

import { app, BrowserWindow, ipcMain, Notification, screen, shell, type Rectangle } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { OpenBitFunRuntime } from '../scripts/openbitfun-runtime.mjs';
import { resolveBambookIconPath } from './brandAssets';
import { AssistantRequestError, AssistantSupervisor } from './assistantSupervisor';

let openbitfunRuntime: OpenBitFunRuntime | null = null;


type SherpaOnlineRecognizer = {
    createStream: () => SherpaOnlineStream;
    isReady: (stream: SherpaOnlineStream) => boolean;
    decode: (stream: SherpaOnlineStream) => void;
    isEndpoint: (stream: SherpaOnlineStream) => boolean;
    reset: (stream: SherpaOnlineStream) => void;
    getResult: (stream: SherpaOnlineStream) => { text?: string; is_final?: boolean; is_eof?: boolean };
    free: () => void;
};

type SherpaOnlineStream = {
    acceptWaveform: (sampleRate: number, samples: Float32Array) => void;
    inputFinished: () => void;
    free: () => void;
};

type LocalSttSession = {
    recognizer: SherpaOnlineRecognizer;
    stream: SherpaOnlineStream;
    createdAt: number;
    lastText: string;
};

type SherpaOnnxModule = {
    createOnlineRecognizer: (config: Record<string, unknown>) => SherpaOnlineRecognizer;
    version?: string;
};

const LOCAL_STT_MODEL_RELATIVE_DIR = path.join('models', 'stt', 'paraformer-zh-en-int8');
const localSttSessions = new Map<string, LocalSttSession>();
let sherpaOnnxModule: SherpaOnnxModule | null = null;

function loadSherpaOnnx(): SherpaOnnxModule {
    if (!sherpaOnnxModule) {
        sherpaOnnxModule = require('sherpa-onnx') as SherpaOnnxModule;
    }
    return sherpaOnnxModule;
}

function resolveLocalSttModelDir(): string {
    const envModelDir = process.env.BAMBOOK_STT_MODEL_DIR;
    const candidates = [
        ...(envModelDir ? [envModelDir] : []),
        path.join(process.resourcesPath, LOCAL_STT_MODEL_RELATIVE_DIR),
        path.resolve(app.getAppPath(), LOCAL_STT_MODEL_RELATIVE_DIR),
        path.resolve(__dirname, '../../', LOCAL_STT_MODEL_RELATIVE_DIR),
    ];
    for (const candidate of candidates) {
        if (
            fsSync.existsSync(path.join(candidate, 'encoder.int8.onnx')) &&
            fsSync.existsSync(path.join(candidate, 'decoder.int8.onnx')) &&
            fsSync.existsSync(path.join(candidate, 'tokens.txt'))
        ) {
            return candidate;
        }
    }
    return candidates[0];
}

function getLocalSttModelStatus() {
    const modelDir = resolveLocalSttModelDir();
    const files = {
        encoder: path.join(modelDir, 'encoder.int8.onnx'),
        decoder: path.join(modelDir, 'decoder.int8.onnx'),
        tokens: path.join(modelDir, 'tokens.txt'),
    };
    return {
        modelDir,
        files,
        exists: Object.values(files).every(file => fsSync.existsSync(file)),
    };
}

function createLocalSttRecognizer(): SherpaOnlineRecognizer {
    const status = getLocalSttModelStatus();
    if (!status.exists) {
        throw new Error(`本地 STT 模型不完整：${status.modelDir}`);
    }
    const sherpa = loadSherpaOnnx();
    return sherpa.createOnlineRecognizer({
        featConfig: {
            sampleRate: 16000,
            featureDim: 80,
        },
        modelConfig: {
            paraformer: {
                encoder: status.files.encoder,
                decoder: status.files.decoder,
            },
            tokens: status.files.tokens,
            numThreads: Math.max(1, Math.min(4, os.cpus().length || 1)),
            provider: 'cpu',
            debug: 0,
            modelType: 'paraformer',
            modelingUnit: 'cjkchar',
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: 1,
        rule1MinTrailingSilence: 1.2,
        rule2MinTrailingSilence: 0.8,
        rule3MinUtteranceLength: 20,
    });
}

function getLocalSttSession(sessionId: string): LocalSttSession {
    const session = localSttSessions.get(sessionId);
    if (!session) throw new Error('本地 STT 会话不存在或已结束');
    return session;
}

function cleanupLocalSttSession(sessionId: string) {
    const session = localSttSessions.get(sessionId);
    if (!session) return;
    localSttSessions.delete(sessionId);
    try {
        session.stream.free();
    } catch {}
    try {
        session.recognizer.free();
    } catch {}
}

function decodeLocalStt(session: LocalSttSession) {
    while (session.recognizer.isReady(session.stream)) {
        session.recognizer.decode(session.stream);
    }
    const result = session.recognizer.getResult(session.stream);
    const text = String(result?.text || '').trim();
    if (text) session.lastText = text;
    const isEndpoint = session.recognizer.isEndpoint(session.stream);
    return {
        ok: true,
        text: session.lastText,
        isEndpoint,
        isFinal: Boolean(result?.is_final || result?.is_eof),
    };
}



let mainWindow: BrowserWindow | null = null;
let agentPetWindow: BrowserWindow | null = null;

const AGENT_PET_HIT_TEST_INTERVAL_MS = 50;

type AgentActivitySnapshot = {
    active: boolean;
    source?: 'assistant' | 'pet-preview' | 'system';
    label?: string;
    detail?: string;
};

type AgentPetRendererErrorPayload = {
    message: string;
    stack?: string;
    source?: string;
};

let agentActivitySnapshot: AgentActivitySnapshot = {
    active: false,
    source: 'system',
    label: 'Agent OS 待命',
};
const agentPetHitRegions = new WeakMap<BrowserWindow, Rectangle[]>();
const agentPetMousePinned = new WeakMap<BrowserWindow, boolean>();
let agentPetHitTestTimer: NodeJS.Timeout | null = null;

function restoreBambookAppPresence() {
    if (process.platform !== 'darwin') return;
    const isUiLabElectron = process.env[BAMBOOK_UI_LAB_ELECTRON_FLAG] === '1';
    app.setName(isUiLabElectron ? BAMBOOK_UI_LAB_TITLE : BAMBOOK_APP_TITLE);
    app.setActivationPolicy('regular');
    app.dock?.show();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setSkipTaskbar(false);
        mainWindow.setAlwaysOnTop(false);
    }
}

if (process.env.BAMBOOK_ELECTRON_UI_LAB !== '1') {
    const hasSingleInstanceLock = app.requestSingleInstanceLock();
    if (!hasSingleInstanceLock) {
        app.quit();
    } else {
        app.on('second-instance', () => {
            focusMainWindow();
            if (agentPetWindow && !agentPetWindow.isDestroyed()) {
                agentPetMousePinned.set(agentPetWindow, false);
                updateAgentPetMousePassthrough(agentPetWindow);
                agentPetWindow.showInactive();
                restoreBambookAppPresence();
            }
        });
    }
}

export const BAMBOOK_OS_WINDOW_MIN_WIDTH = 1080;
export const BAMBOOK_OS_WINDOW_MIN_HEIGHT = 760;
export const BAMBOOK_UI_LAB_ELECTRON_FLAG = 'BAMBOOK_ELECTRON_UI_LAB';
export const BAMBOOK_UI_LAB_ICON_PATH = path.resolve(__dirname, '../../build/ui-lab-icon.png');
export const BAMBOOK_UI_LAB_TITLE = 'Bambook UI Lab';
export const BAMBOOK_UI_LAB_USER_DATA_DIR = 'bambook-ui-lab';
export const BAMBOOK_APP_TITLE = 'Bambook';
let serverProcess: ReturnType<typeof execFile> | null = null;

function lockRendererZoom(window: BrowserWindow) {
    window.webContents.setZoomFactor(1);
    window.webContents.setVisualZoomLevelLimits(1, 1).catch((err: any) => {
        process.stderr.write(`[renderer] failed to lock visual zoom: ${err?.message || err}\n`);
    });
    window.webContents.on('before-input-event', (event, input) => {
        const key = input.key.toLowerCase();
        const isZoomShortcut = (input.control || input.meta) && ['+', '=', '-', '_', '0'].includes(key);
        if (!isZoomShortcut) return;

        event.preventDefault();
        window.webContents.setZoomFactor(1);
    });
}

function normalizeAgentActivity(snapshot: Partial<AgentActivitySnapshot>): AgentActivitySnapshot {
    return {
        active: Boolean(snapshot.active),
        source: snapshot.source === 'assistant' || snapshot.source === 'pet-preview' || snapshot.source === 'system'
            ? snapshot.source
            : 'system',
        label: typeof snapshot.label === 'string' ? snapshot.label.slice(0, 120) : undefined,
        detail: typeof snapshot.detail === 'string' ? snapshot.detail.slice(0, 180) : undefined,
    };
}

function broadcastAgentActivity(snapshot: Partial<AgentActivitySnapshot>) {
    agentActivitySnapshot = normalizeAgentActivity(snapshot);
    BrowserWindow.getAllWindows().forEach((window) => {
        if (window.webContents.isDestroyed()) return;
        window.webContents.send('agent-os:activity', agentActivitySnapshot);
    });
    return agentActivitySnapshot;
}

function normalizeAgentPetRendererError(payload: Partial<AgentPetRendererErrorPayload>): AgentPetRendererErrorPayload {
    return {
        message: typeof payload.message === 'string' && payload.message.trim()
            ? payload.message.trim().slice(0, 600)
            : 'Agent 浮窗渲染错误',
        stack: typeof payload.stack === 'string' ? payload.stack.slice(0, 1800) : undefined,
        source: typeof payload.source === 'string' ? payload.source.slice(0, 80) : undefined,
    };
}

function reportAgentPetRendererError(window: BrowserWindow | null, payload: Partial<AgentPetRendererErrorPayload>) {
    const normalized = normalizeAgentPetRendererError(payload);
    process.stderr.write(`[agent-pet] renderer error: ${normalized.message}\n`);
    if (normalized.stack) process.stderr.write(`${normalized.stack}\n`);

    if (window && !window.isDestroyed()) {
        window.setIgnoreMouseEvents(true, { forward: true });
        window.hide();
    }

    mainWindow?.webContents.send('agent-os:pet-renderer-error', normalized);
    broadcastAgentActivity({
        active: false,
        source: 'pet-preview',
        label: 'Agent 浮窗渲染错误',
        detail: normalized.message,
    });
    focusMainWindow();

    if (window && !window.isDestroyed()) {
        setTimeout(() => {
            if (!window.isDestroyed()) window.close();
        }, 0);
    }
}

function focusMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (process.platform === 'darwin') {
        app.setActivationPolicy('regular');
        app.dock?.show();
    }
    mainWindow.show();
    mainWindow.focus();
}

function loadAgentPetRenderer(window: BrowserWindow, version: '1' | 'classic', devUrl?: string) {
    if (devUrl) {
        const url = new URL(devUrl);
        url.searchParams.set('bambookAgentPet', version);
        url.searchParams.set('hideViteOverlay', '1');
        window.loadURL(url.toString());
        return;
    }

    window.loadFile(path.join(__dirname, '../renderer/index.html'), {
        query: { bambookAgentPet: version },
    });
}

function pointInRectangle(point: { x: number; y: number }, rect: Rectangle): boolean {
    return point.x >= rect.x
        && point.x <= rect.x + rect.width
        && point.y >= rect.y
        && point.y <= rect.y + rect.height;
}

function updateAgentPetMousePassthrough(window: BrowserWindow) {
    if (window.isDestroyed()) return;
    if (agentPetMousePinned.get(window)) return;
    const cursor = screen.getCursorScreenPoint();
    const regions = agentPetHitRegions.get(window) || [];
    const insideInteractiveRegion = regions.some((region) => pointInRectangle(cursor, region));
    if (insideInteractiveRegion) {
        window.setIgnoreMouseEvents(false);
    } else {
        window.setIgnoreMouseEvents(true, { forward: true });
    }
}

function ensureAgentPetHitTesting() {
    if (agentPetHitTestTimer) return;
    agentPetHitTestTimer = setInterval(() => {
        const windows = [agentPetWindow].filter(
            (window): window is BrowserWindow => Boolean(window && !window.isDestroyed()),
        );

        if (windows.length === 0) {
            if (agentPetHitTestTimer) clearInterval(agentPetHitTestTimer);
            agentPetHitTestTimer = null;
            return;
        }

        const cursor = screen.getCursorScreenPoint();
        windows.forEach((window) => {
            if (agentPetMousePinned.get(window)) return;
            const regions = agentPetHitRegions.get(window) || [];
            const insideInteractiveRegion = regions.some((region) => pointInRectangle(cursor, region));
            if (insideInteractiveRegion) window.setIgnoreMouseEvents(false);
            else window.setIgnoreMouseEvents(true, { forward: true });
        });
    }, AGENT_PET_HIT_TEST_INTERVAL_MS);
}

function expandAgentPetWindowToDisplay(window: BrowserWindow) {
    const display = screen.getDisplayMatching(window.getBounds());
    const { x, y, width, height } = display.bounds;
    window.setMinimumSize(1, 1);
    window.setMaximumSize(width, height);
    window.setBounds({ x, y, width, height }, false);
}

function createAgentPetWindow(version: '1', devUrl?: string): void {
    if (process.env[BAMBOOK_UI_LAB_ELECTRON_FLAG] === '1') return;
    
    let win = agentPetWindow;
    const targetDisplay = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();
    const { x, y, width, height } = targetDisplay.workArea;
    const initialBounds = { x, y, width, height };
    
    if (win && !win.isDestroyed()) {
        agentPetMousePinned.set(win, false);
        win.setResizable(true);
        win.setMinimumSize(1, 1);
        win.setMaximumSize(width, height);
        win.setBounds(initialBounds, false);
        win.setSize(width, height, false);
        win.setContentSize(width, height, false);
        win.setIgnoreMouseEvents(true, { forward: true });
        win.showInactive();
        restoreBambookAppPresence();
        setTimeout(restoreBambookAppPresence, 0);
        return;
    }

    win = new BrowserWindow({
        ...initialBounds,
        title: 'Bambook Agent',
        frame: false,
        transparent: true,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        backgroundColor: '#00000000',
        show: false,
        acceptFirstMouse: true,
        movable: true,
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: true,
        },
    });
    win.setMinimumSize(1, 1);
    win.setMaximumSize(width, height);
    win.setBounds(initialBounds, false);
    win.setSize(width, height, false);
    win.setContentSize(width, height, false);
    agentPetMousePinned.set(win, false);
    win.setIgnoreMouseEvents(true, { forward: true });

    if (version === '1') agentPetWindow = win;

    if (process.platform === 'darwin') {
        win.setAlwaysOnTop(true, 'floating');
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        restoreBambookAppPresence();
    }

    win.once('ready-to-show', () => {
        win?.showInactive();
        restoreBambookAppPresence();
        setTimeout(restoreBambookAppPresence, 0);
        broadcastAgentActivity({
            active: true,
            source: 'pet-preview',
            label: 'Agent OS 演示运行中',
            detail: '熊猫浮窗已连接主程序',
        });
    });
    win.on('closed', () => {
        agentPetHitRegions.delete(win);
        agentPetMousePinned.delete(win);
        if (version === '1') agentPetWindow = null;
        broadcastAgentActivity({
            active: false,
            source: 'pet-preview',
            label: 'Agent OS 待命',
            detail: '宠物浮窗已关闭',
        });
        restoreBambookAppPresence();
    });
    win.webContents.on('did-fail-load', (_event, code, desc, url) => {
        reportAgentPetRendererError(win, {
            message: `Agent 浮窗加载失败 (${code}): ${desc}`,
            source: url,
        });
    });
    win.webContents.on('render-process-gone', (_event, details) => {
        reportAgentPetRendererError(win, {
            message: `Agent 浮窗进程异常退出: ${details.reason}`,
            stack: JSON.stringify(details),
            source: 'render-process-gone',
        });
    });
    loadAgentPetRenderer(win, version, devUrl);
}

// ── 内嵌后端：Electron 启动时自动拉起 Express ─────────────────
// 如果 /api 请求连不上外部服务器（Mac mini 等），就在本机起一个。
// Mac mini 上跑的 Bambook 也会自带这个，launchd 管的就是它。
const SERVER_DIR = path.resolve(__dirname, '../../server');
const SERVER_ENTRY = path.join(SERVER_DIR, 'src/index.ts');

function startEmbeddedServer() {
    // 已经在跑就不重复起
    if (serverProcess) return;

    const tsNode = path.join(SERVER_DIR, 'node_modules', '.bin', 'ts-node');
    const canUseTsNode = fsSync.existsSync(tsNode);

    const cmd = canUseTsNode ? tsNode : 'npx';
    const args = canUseTsNode ? [SERVER_ENTRY] : ['ts-node', SERVER_ENTRY];

    process.stderr.write(`[bambook-server] starting: ${cmd} ${args.join(' ')}\n`);
    serverProcess = execFile(cmd, args, {
        cwd: SERVER_DIR,
        env: { ...process.env, PORT: '8081', NODE_ENV: 'production' },
    }, (err) => {
        if (err) process.stderr.write(`[bambook-server] exited: ${err?.message}\n`);
        serverProcess = null;
    });
    serverProcess.stdout?.on('data', (d: Buffer) => process.stderr.write(d));
    serverProcess.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
}

function stopEmbeddedServer() {
    if (serverProcess && !serverProcess.killed) {
        serverProcess.kill();
        serverProcess = null;
    }
}

// 检测后端是否可连（给前端 IPC 用）
async function checkServerHealth(host: string, port: number): Promise<{ ok: boolean; ms?: number }> {
    return new Promise((resolve) => {
        const start = Date.now();
        const req = http.get(`http://${host}:${port}/api/health`, { timeout: 3000 }, (res) => {
            resolve({ ok: res.statusCode === 200, ms: Date.now() - start });
            res.resume();
        });
        req.on('error', () => resolve({ ok: false }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    });
}

// ── Window-control IPC handlers ─────────────────────────────────────────
// The frameless window has no native title bar. The renderer (see
// components/WindowControls.tsx) draws / triggers buttons via these
// handlers. Registered ONCE at module load (handlers are idempotent and
// scoped to whichever BrowserWindow is currently `mainWindow`).
ipcMain.handle('window:set-traffic-lights', (_e, visible: boolean) => {
    // macOS only — toggles native red/yellow/green circle visibility. No-op
    // on Windows/Linux where there are no traffic lights to show/hide.
    if (process.platform === 'darwin' && mainWindow) {
        mainWindow.setWindowButtonVisibility(mainWindow.isFullScreen() ? true : Boolean(visible));
    }
});
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
});
ipcMain.handle('window:close', () => mainWindow?.close());
// Fullscreen state — pulled by the renderer once on mount, then pushed
// via `window:fullscreen-changed` whenever it flips.
ipcMain.handle('window:is-fullscreen', () => Boolean(mainWindow?.isFullScreen()));
ipcMain.handle('agent-os:get-activity', () => agentActivitySnapshot);
ipcMain.handle('agent-os:publish-activity', (_event, snapshot: Partial<AgentActivitySnapshot>) => {
    return broadcastAgentActivity(snapshot);
});
ipcMain.handle('agent-os:open-pet-window', () => {
    createAgentPetWindow('1', process.env.ELECTRON_RENDERER_URL);
    
    return { ok: true };
});
ipcMain.handle('agent-os:focus-view', (_event, view: 'assistant' | 'system-settings') => {
    focusMainWindow();
    mainWindow?.webContents.send('agent-os:focus-view', view);
    return { ok: Boolean(mainWindow && !mainWindow.isDestroyed()) };
});

// D2 主动提醒引擎 — 桌面原生推送：warning/critical 预警在窗口不可见时
// 通过 OS 通知中心触达；点击回到主窗口并跳转到通知携带的业务链接。
ipcMain.handle('notification:show-native', (_event, payload: { title?: string; body?: string; link?: string }) => {
    if (!Notification.isSupported()) return { ok: false, reason: 'unsupported' };
    const title = typeof payload?.title === 'string' ? payload.title.slice(0, 120) : '';
    const body = typeof payload?.body === 'string' ? payload.body.slice(0, 300) : '';
    const link = typeof payload?.link === 'string' ? payload.link : undefined;
    if (!title) return { ok: false, reason: 'missing-title' };

    const notification = new Notification({ title, body });
    notification.on('click', () => {
        focusMainWindow();
        if (link && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('notification:open-link', link);
        }
    });
    notification.show();
    return { ok: true };
});

function moveAgentPetWindowBy(sourceWindow: BrowserWindow | null, delta: { dx?: number; dy?: number }) {
    if (!sourceWindow || sourceWindow.isDestroyed()) return { ok: false, reason: 'missing-window' };
    const dx = Number.isFinite(delta?.dx) ? Number(delta.dx) : 0;
    const dy = Number.isFinite(delta?.dy) ? Number(delta.dy) : 0;
    if (dx === 0 && dy === 0) return { ok: true };
    sourceWindow.setMovable(true);
    const bounds = sourceWindow.getBounds();
    const nextBounds = {
        ...bounds,
        x: Math.round(bounds.x + dx),
        y: Math.round(bounds.y + dy),
    };
    sourceWindow.setBounds(nextBounds, false);
    const movedBounds = sourceWindow.getBounds();
    return { ok: true, bounds: movedBounds };
}

ipcMain.handle('agent-os:move-pet-window-by', (event, delta: { dx?: number; dy?: number }) => {
    return moveAgentPetWindowBy(BrowserWindow.fromWebContents(event.sender), delta);
});

ipcMain.on('agent-os:move-pet-window-by', (event, delta: { dx?: number; dy?: number }) => {
    moveAgentPetWindowBy(BrowserWindow.fromWebContents(event.sender), delta);
});

ipcMain.handle('agent-os:set-pet-menu-open', (event, open: boolean) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.isDestroyed()) return { ok: false };

    if (open) {
        return {
            ok: true,
            bounds: sourceWindow.getBounds(),
            offsetX: 0,
            offsetY: 0,
        };
    }

    return { ok: true };
});

ipcMain.handle('agent-os:set-pet-mouse-passthrough', (event, passthrough: boolean) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.isDestroyed()) return { ok: false };
    if (passthrough) {
        agentPetMousePinned.set(sourceWindow, false);
        sourceWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
        agentPetMousePinned.set(sourceWindow, true);
        sourceWindow.setIgnoreMouseEvents(false);
    }
    return { ok: true };
});

ipcMain.handle('agent-os:set-pet-mouse-capture', (event, capture: boolean) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.isDestroyed()) return { ok: false };
    if (capture) {
        agentPetMousePinned.set(sourceWindow, true);
        sourceWindow.setIgnoreMouseEvents(false);
    } else {
        agentPetMousePinned.set(sourceWindow, false);
        updateAgentPetMousePassthrough(sourceWindow);
    }
    return { ok: true };
});

ipcMain.handle('agent-os:set-pet-hit-regions', (event, regions: Rectangle[]) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.isDestroyed()) return { ok: false };
    const bounds = sourceWindow.getBounds();
    const normalized = Array.isArray(regions)
        ? regions
            .map((region) => ({
                x: Math.round(bounds.x + Number(region?.x ?? 0)),
                y: Math.round(bounds.y + Number(region?.y ?? 0)),
                width: Math.max(0, Math.round(Number(region?.width ?? 0))),
                height: Math.max(0, Math.round(Number(region?.height ?? 0))),
            }))
            .filter((region) => (
                Number.isFinite(region.x)
                && Number.isFinite(region.y)
                && Number.isFinite(region.width)
                && Number.isFinite(region.height)
                && region.width > 0
                && region.height > 0
            ))
        : [];
    agentPetHitRegions.set(sourceWindow, normalized);
    ensureAgentPetHitTesting();
    if (!agentPetMousePinned.get(sourceWindow)) {
        updateAgentPetMousePassthrough(sourceWindow);
    }
    return { ok: true };
});
ipcMain.on('agent-os:pet-renderer-error', (event, payload: Partial<AgentPetRendererErrorPayload>) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (sourceWindow !== agentPetWindow) return;
    reportAgentPetRendererError(sourceWindow, payload);
});

// ── 后端健康检查 & 自动启动 ─────────────────────────────────────
ipcMain.handle('server:health', async (_event, host: string, port: number) => {
    return checkServerHealth(host || 'localhost', port || 8081);
});

ipcMain.handle('server:start-embedded', () => {
    startEmbeddedServer();
    return { started: true };
});

ipcMain.handle('server:stop-embedded', () => {
    stopEmbeddedServer();
    return { stopped: true };
});

const sanitizeFilename = (name: string) =>
    name
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'sample-invoice';

ipcMain.handle('invoice:save-pdf', async (_event, payload: { html: string; filename: string }) => {
    const html = String(payload?.html || '');
    if (!html) throw new Error('Missing invoice HTML');

    const filename = `${sanitizeFilename(String(payload?.filename || 'sample-invoice')).replace(/\.pdf$/i, '')}.pdf`;
    const outputPath = path.join(app.getPath('downloads'), filename);
    const tempHtmlPath = path.join(os.tmpdir(), `bambook-invoice-${Date.now()}.html`);
    let printWindow: BrowserWindow | null = null;

    try {
        await fs.writeFile(tempHtmlPath, html, 'utf8');
        printWindow = new BrowserWindow({
            show: false,
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });

        await printWindow.loadFile(tempHtmlPath);
        const pdf = await printWindow.webContents.printToPDF({
            printBackground: true,
            landscape: true,
            pageSize: 'A5',
            margins: {
                marginType: 'none',
            },
        });

        await fs.writeFile(outputPath, pdf);
        return { path: outputPath };
    } finally {
        printWindow?.destroy();
        fs.rm(tempHtmlPath, { force: true }).catch(() => undefined);
    }
});

function createWindow(): void {
    const isMac = process.platform === 'darwin';
    const isUiLabElectron = process.env[BAMBOOK_UI_LAB_ELECTRON_FLAG] === '1';
    const iconPath = resolveBambookIconPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, mainDirectory: __dirname });
    const iconExists = fsSync.existsSync(iconPath);
    const dockTitle = isUiLabElectron ? BAMBOOK_UI_LAB_TITLE : BAMBOOK_APP_TITLE;

    app.setName(dockTitle);
    if (isMac) {
        app.setActivationPolicy('regular');
        app.dock?.show();
        if (iconExists) {
            app.dock?.setIcon(iconPath);
        }
    }

    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: BAMBOOK_OS_WINDOW_MIN_WIDTH,
        minHeight: BAMBOOK_OS_WINDOW_MIN_HEIGHT,
        title: isUiLabElectron ? BAMBOOK_UI_LAB_TITLE : 'Bambook 竹衍 | Enterprise Agent OS',
        backgroundColor: '#ffffff',
        show: false,
        ...(iconExists ? { icon: iconPath } : {}),
        skipTaskbar: false,
        alwaysOnTop: false,
        // ── Fully chromeless window — no title bar, no OS-native window
        // control buttons (close / minimize / maximize / traffic lights).
        // The CSS drag region (-webkit-app-region: drag on body) handles
        // window moves. Quit / hide / minimize work via the standard
        // keyboard shortcuts (Cmd+Q / Cmd+H / Cmd+M on macOS, Alt+F4 on
        // Windows) and via the application menu (still wired by Electron).
        //
        // macOS-specific: `titleBarStyle: 'hiddenInset'` removes the title
        // bar; we additionally call `setWindowButtonVisibility(false)`
        // below to hide the traffic-light circles. We deliberately keep
        // `hiddenInset` (vs `frame: false`) so the window keeps native
        // rounded corners and shadow.
        ...(isMac
            ? { titleBarStyle: 'hiddenInset' as const }
            : { frame: false }),
        webPreferences: {
            // Security baseline. Renderer cannot touch Node directly; it must
            // go through the preload bridge (added in B8 for IPC migration).
            preload: path.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: true,
        },
    });
    mainWindow.setSkipTaskbar(false);
    mainWindow.setAlwaysOnTop(false);
    lockRendererZoom(mainWindow);

    // macOS only — actually hide the traffic-light circles. The
    // `titleBarStyle` above removes the title bar but the buttons remain
    // floating in the top-left corner unless we explicitly hide them.
    if (isMac) {
        mainWindow.setWindowButtonVisibility(false);
    }

    // Push fullscreen-state changes to the renderer. On macOS we must also
    // restore native traffic-light visibility while fullscreen: the window
    // starts with `setWindowButtonVisibility(false)`, and macOS cannot reveal
    // buttons that Electron has explicitly hidden.
    mainWindow.on('enter-full-screen', () => {
        if (isMac) mainWindow?.setWindowButtonVisibility(true);
        mainWindow?.webContents.send('window:fullscreen-changed', true);
    });
    mainWindow.on('leave-full-screen', () => {
        if (isMac) mainWindow?.setWindowButtonVisibility(false);
        mainWindow?.webContents.send('window:fullscreen-changed', false);
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });

    // Open external links in the user's default browser instead of a new
    // BrowserWindow — prevents a hostile/redirected link from running with
    // Electron privileges.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const parsed = new URL(url);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                shell.openExternal(url);
            }
        } catch {
            // invalid URL — ignore
        }
        return { action: 'deny' };
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
        if (agentPetWindow && !agentPetWindow.isDestroyed()) {
            agentPetWindow.close();
        }
    });

    // electron-vite injects ELECTRON_RENDERER_URL during `electron-vite dev`.
    // In prod it is undefined and we load the bundled renderer.
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) {
        const uiLabDevUrl = new URL('/archive/ui-lab/dev-ui-lab.html', devUrl).toString();
        mainWindow.loadURL(isUiLabElectron ? uiLabDevUrl : devUrl);
        mainWindow.webContents.openDevTools({ mode: 'detach' });
        // Reminder banner so dev-mode jank (StrictMode double-render +
        // unminified JS + sourcemap overhead) is never confused with a real
        // production performance issue. Fires once per launch in the main
        // process stderr — visible in the launcher terminal.
        process.stderr.write(
            '\n' +
            '════════════════════════════════════════════════════════\n' +
            '  Electron DEV mode — performance is NOT representative.\n' +
            '  Dashboard globe may stutter (React.StrictMode + dev\n' +
            '  bundle overhead). Production preview / DMG runs full 60fps.\n' +
            '════════════════════════════════════════════════════════\n\n'
        );
    } else {
        const uiLabPath = path.join(__dirname, '../renderer/archive/ui-lab/dev-ui-lab.html');
        const defaultPath = path.join(__dirname, '../renderer/index.html');
        mainWindow.loadFile(isUiLabElectron && fsSync.existsSync(uiLabPath) ? uiLabPath : defaultPath);
    }

    // Always surface load failures and renderer crashes to main-process
    // stderr — these would otherwise produce a silent white window in
    // production. (Cheap; no DevTools window is opened.)
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
        process.stderr.write(`[renderer] did-fail-load ${code} ${desc} ${url}\n`);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
        process.stderr.write(`[renderer] render-process-gone ${JSON.stringify(details)}\n`);
    });
}



ipcMain.handle('stt:local-status', () => {
    const model = getLocalSttModelStatus();
    return {
        ok: true,
        platform: process.platform,
        arch: process.arch,
        sherpaVersion: sherpaOnnxModule?.version,
        activeSessions: localSttSessions.size,
        model: {
            exists: model.exists,
            dir: model.modelDir,
            files: model.files,
        },
    };
});

ipcMain.handle('stt:local-prepare', async () => {
    try {
        const model = getLocalSttModelStatus();
        if (!model.exists) {
            return { ok: false, error: `本地 STT 模型不完整：${model.modelDir}`, model };
        }
        const sherpa = loadSherpaOnnx();
        return {
            ok: true,
            sherpaVersion: sherpa.version,
            model: {
                dir: model.modelDir,
                exists: model.exists,
            },
        };
    } catch (err: any) {
        process.stderr.write(`[stt:local-prepare] error: ${err?.message}\n`);
        return { ok: false, error: err?.message || '本地 STT 初始化失败' };
    }
});

ipcMain.handle('stt:local-start', async () => {
    try {
        const recognizer = createLocalSttRecognizer();
        const stream = recognizer.createStream();
        const sessionId = `stt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        localSttSessions.set(sessionId, {
            recognizer,
            stream,
            createdAt: Date.now(),
            lastText: '',
        });
        return { ok: true, sessionId, sampleRate: 16000 };
    } catch (err: any) {
        process.stderr.write(`[stt:local-start] error: ${err?.message}\n`);
        return { ok: false, error: err?.message || '本地 STT 启动失败' };
    }
});

ipcMain.handle('stt:local-push-pcm', async (_event, payload: { sessionId?: string; pcm?: ArrayBuffer; sampleRate?: number }) => {
    try {
        const sessionId = String(payload?.sessionId || '');
        if (!sessionId) throw new Error('缺少 STT sessionId');
        const session = getLocalSttSession(sessionId);
        const samples = new Float32Array(payload.pcm || new ArrayBuffer(0));
        if (samples.length === 0) {
            return { ok: true, text: session.lastText, isEndpoint: false, isFinal: false };
        }
        session.stream.acceptWaveform(Number(payload.sampleRate || 16000), samples);
        return decodeLocalStt(session);
    } catch (err: any) {
        process.stderr.write(`[stt:local-push-pcm] error: ${err?.message}\n`);
        return { ok: false, error: err?.message || '本地 STT 识别失败' };
    }
});

ipcMain.handle('stt:local-finish', async (_event, sessionId: string) => {
    try {
        const id = String(sessionId || '');
        if (!id) throw new Error('缺少 STT sessionId');
        const session = getLocalSttSession(id);
        session.stream.inputFinished();
        const decoded = decodeLocalStt(session);
        const text = decoded.text || session.lastText;
        cleanupLocalSttSession(id);
        return { ok: true, text, isFinal: true };
    } catch (err: any) {
        process.stderr.write(`[stt:local-finish] error: ${err?.message}\n`);
        return { ok: false, error: err?.message || '本地 STT 收尾失败' };
    }
});

ipcMain.handle('stt:local-stop', async (_event, sessionId: string) => {
    cleanupLocalSttSession(String(sessionId || ''));
    return { ok: true };
});

// ── 刷新窗口的 IPC 通道 + 全局快捷键 ──
// 当 Vite HMR 不工作时，用户可通过 Cmd+Shift+R 或 IPC 调用强制刷新
ipcMain.handle('dev:hard-reload', () => {
    BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.webContents.reload();
    });
    return { ok: true };
});

function getOpenBitFunRuntime() {
    if (!openbitfunRuntime) {
        openbitfunRuntime = new OpenBitFunRuntime({
            bundleRoot: app.isPackaged
                ? path.join(process.resourcesPath, 'openbitfun')
                : path.join(app.getAppPath(), 'tmp/openbitfun-runtime'),
            // Development windows share the same registered owner as npm run dev.
            // Packaged installations retain their existing persistent workspace.
            workspace: app.isPackaged
                ? path.join(app.getPath('userData'), 'agent-workspace')
                : path.join(app.getAppPath(), 'tmp/openbitfun-workspace'),
            webDevRoot: app.isPackaged ? undefined : path.join(app.getAppPath(), 'tmp/upstream/OpenBitFun/src/web-ui'),
            // This module is bundled into out/main; its import.meta path is not
            // the source scripts directory. Pass the Node entry explicitly.
            webDevEntry: app.isPackaged ? undefined : path.join(app.getAppPath(), 'scripts/openbitfun-web-dev.mjs'),
        });
    }
    return openbitfunRuntime;
}

// 工作助手（本机 Agent）：assistant-host 独立进程，只接受主窗口主框架的请求。
let assistantSupervisor: AssistantSupervisor | null = null;
function getAssistantSupervisor() {
    assistantSupervisor ??= new AssistantSupervisor({
        hostPath: path.join(__dirname, 'assistant-host.js'),
        dataDir: path.join(app.getPath('userData'), 'assistant'),
        send: (channel, payload) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
        },
    });
    return assistantSupervisor;
}
ipcMain.handle('assistant:request', async (event, method: unknown, params: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new Error('Untrusted assistant caller');
    }
    try {
        return { ok: true, result: await getAssistantSupervisor().request(method, params) };
    } catch (error) {
        return error instanceof AssistantRequestError
            ? { ok: false, error: { code: error.code, message: error.message } }
            : { ok: false, error: { code: 'INTERNAL', message: '工作助手请求失败，请重试' } };
    }
});

for (const operation of ['start', 'status'] as const) {
    ipcMain.handle(`openbitfun:${operation}`, async (event) => {
        // The embedded workbench (and other windows) cannot use this bridge.
        if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
            throw new Error('Untrusted Agent runtime caller');
        }
        return getOpenBitFunRuntime()[operation]();
    });
}

app.whenReady().then(() => {
    // 注册全局快捷键 Cmd+Shift+R → 刷新所有窗口（开发调试用）
    const { globalShortcut } = require('electron');
    const registered = globalShortcut.register('CommandOrControl+Shift+R', () => {
        BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) win.webContents.reload();
        });
    });
    if (!registered) {
        process.stderr.write('[globalShortcut] Cmd+Shift+R registration failed — may be taken by another app\n');
    }
    if (process.platform === 'darwin') {
        app.setActivationPolicy('regular');
        app.dock?.show();
    }
    if (process.env[BAMBOOK_UI_LAB_ELECTRON_FLAG] === '1') {
        app.setName(BAMBOOK_UI_LAB_TITLE);
        app.setPath('userData', path.join(app.getPath('appData'), BAMBOOK_UI_LAB_USER_DATA_DIR));
    }
    createWindow();

    app.on('activate', () => {
        // macOS: re-create a window when the dock icon is clicked and there
        // are no other windows open.
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    // macOS apps typically stay alive until Cmd+Q. Quit on every other OS.
    if (process.platform !== 'darwin') app.quit();
});

// 清理：退出时停掉内嵌后端 + 注销全局快捷键
app.on('before-quit', () => {
    const { globalShortcut } = require('electron');
    globalShortcut.unregisterAll();
    Array.from(localSttSessions.keys()).forEach(cleanupLocalSttSession);
    openbitfunRuntime?.stop();
    assistantSupervisor?.stop();
    stopEmbeddedServer();
});
