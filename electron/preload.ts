// Bambook — Electron preload bridge.
//
// Runs in an isolated world between the main process and the renderer.
// Anything the renderer needs from Node/Electron must be explicitly exposed
// here via contextBridge — never relax contextIsolation/nodeIntegration to
// avoid this step.
//
// At B1 we expose only a tiny diagnostic surface so the renderer can confirm
// it is actually running inside Electron (used by B1f smoke check). Real IPC
// handlers (database queries, Express endpoints replaced by ipcMain.handle,
// file dialogs, etc.) land in B8.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bambook', {
    // Read-only metadata. No function that triggers side effects yet.
    platform: process.platform,
    versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
    },
});

// Window-control bridge — used by components/WindowControls.tsx to drive
// the hover-revealed traffic-light / min-max-close buttons in the
// frameless window. Each method is a thin wrapper around the matching
// ipcMain.handle in electron/main.ts. Kept separate from the `bambook`
// namespace so the surface area is obvious during security review.
contextBridge.exposeInMainWorld('bambookWindow', {
    setTrafficLights: (visible: boolean) =>
        ipcRenderer.invoke('window:set-traffic-lights', visible),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isFullScreen: () =>
        ipcRenderer.invoke('window:is-fullscreen') as Promise<boolean>,
    onFullScreenChange: (cb: (fs: boolean) => void) => {
        const handler = (_e: unknown, fs: boolean) => cb(fs);
        ipcRenderer.on('window:fullscreen-changed', handler);
        // Returns an unsubscribe so the renderer can clean up on unmount.
        return () => ipcRenderer.removeListener('window:fullscreen-changed', handler);
    },
});

contextBridge.exposeInMainWorld('bambookInvoice', {
    savePdf: (html: string, filename: string) =>
        ipcRenderer.invoke('invoice:save-pdf', { html, filename }) as Promise<{ path: string }>,
});

// D2 主动提醒引擎 — 桌面原生推送桥。渲染进程在窗口不可见且收到
// warning/critical 预警时调用 showNative；点击 OS 通知后主进程回发
// notification:open-link，渲染端订阅后执行路由跳转。
contextBridge.exposeInMainWorld('bambookNotification', {
    showNative: (payload: { title: string; body?: string; link?: string }) =>
        ipcRenderer.invoke('notification:show-native', payload) as Promise<{ ok: boolean; reason?: string }>,
    onOpenLink: (cb: (link: string) => void) => {
        const handler = (_e: unknown, link: string) => cb(link);
        ipcRenderer.on('notification:open-link', handler);
        return () => ipcRenderer.removeListener('notification:open-link', handler);
    },
});



// 后端健康检查 & 内嵌启动（给前端设置页用）
// Only the top-level Bambook renderer gets the local runtime lifecycle bridge.
if (process.isMainFrame) {
    contextBridge.exposeInMainWorld('bambookOpenBitFun', {
        start: () => ipcRenderer.invoke('openbitfun:start'),
        status: () => ipcRenderer.invoke('openbitfun:status'),
    });
}

// 工作助手桥：仅主窗口主框架可用；凭据与模型调用都在 assistant-host 里，渲染进程只拿结果与事件。
if (process.isMainFrame) {
    contextBridge.exposeInMainWorld('bambookAssistant', {
        request: (method: string, params?: unknown) =>
            ipcRenderer.invoke('assistant:request', method, params) as Promise<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }>,
        onEvent: (cb: (event: unknown) => void) => {
            const handler = (_e: unknown, payload: unknown) => cb(payload);
            ipcRenderer.on('assistant:event', handler);
            return () => ipcRenderer.removeListener('assistant:event', handler);
        },
    });
}

contextBridge.exposeInMainWorld('bambookServer', {
    health: (host: string, port: number) =>
        ipcRenderer.invoke('server:health', host, port) as Promise<{ ok: boolean; ms?: number }>,
    startEmbedded: () =>
        ipcRenderer.invoke('server:start-embedded') as Promise<{ started: boolean }>,
    stopEmbedded: () =>
        ipcRenderer.invoke('server:stop-embedded') as Promise<{ stopped: boolean }>,
});



contextBridge.exposeInMainWorld('bambookLocalSTT', {
    status: () =>
        ipcRenderer.invoke('stt:local-status') as Promise<LocalSttStatusResult>,
    prepare: () =>
        ipcRenderer.invoke('stt:local-prepare') as Promise<LocalSttPrepareResult>,
    start: () =>
        ipcRenderer.invoke('stt:local-start') as Promise<LocalSttStartResult>,
    pushPcm: (sessionId: string, pcm: ArrayBuffer, sampleRate: number) =>
        ipcRenderer.invoke('stt:local-push-pcm', { sessionId, pcm, sampleRate }) as Promise<LocalSttPushResult>,
    finish: (sessionId: string) =>
        ipcRenderer.invoke('stt:local-finish', sessionId) as Promise<LocalSttFinishResult>,
    stop: (sessionId: string) =>
        ipcRenderer.invoke('stt:local-stop', sessionId) as Promise<{ ok: boolean; error?: string }>,
});

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

function readAgentPetRendererErrorFromOverlay(overlay: Element): AgentPetRendererErrorPayload {
    const root = overlay.shadowRoot || overlay;
    const text = (root.textContent || '').replace(/\s+/g, ' ').trim();
    return {
        message: text || 'Agent 浮窗渲染错误',
        source: 'vite-error-overlay',
    };
}

function reportAgentPetRendererError(payload: AgentPetRendererErrorPayload) {
    ipcRenderer.send('agent-os:pet-renderer-error', {
        ...payload,
        message: String(payload.message || 'Agent 浮窗渲染错误').slice(0, 600),
        stack: payload.stack ? String(payload.stack).slice(0, 1800) : undefined,
        source: payload.source ? String(payload.source).slice(0, 80) : undefined,
    });
}

function installAgentPetRendererErrorBridge() {
    if (new URLSearchParams(window.location.search).get('bambookAgentPet') !== '1') return;

    const applyPetHostClass = () => {
        document.documentElement?.classList.add('bambook-agent-pet-host');
        document.body?.classList.add('bambook-agent-pet-host');
    };

    applyPetHostClass();

    window.addEventListener('error', (event) => {
        reportAgentPetRendererError({
            message: event.message || event.error?.message || 'Agent 浮窗运行错误',
            stack: event.error?.stack,
            source: 'window.error',
        });
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        reportAgentPetRendererError({
            message: reason?.message || String(reason || 'Agent 浮窗异步错误'),
            stack: reason?.stack,
            source: 'unhandledrejection',
        });
    });

    const handleOverlay = (overlay: Element) => {
        (overlay as HTMLElement).style.display = 'none';
        reportAgentPetRendererError(readAgentPetRendererErrorFromOverlay(overlay));
    };

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            mutation.addedNodes.forEach((node) => {
                if (!(node instanceof Element)) return;
                if (node.tagName.toLowerCase() === 'vite-error-overlay') {
                    handleOverlay(node);
                    return;
                }
                node.querySelectorAll?.('vite-error-overlay').forEach(handleOverlay);
            });
        }
    });

    window.addEventListener('DOMContentLoaded', () => {
        applyPetHostClass();
        document.querySelectorAll('vite-error-overlay').forEach(handleOverlay);
        observer.observe(document.documentElement, { childList: true, subtree: true });
    });
}

installAgentPetRendererErrorBridge();

contextBridge.exposeInMainWorld('bambookAgent', {
    getActivity: () =>
        ipcRenderer.invoke('agent-os:get-activity') as Promise<AgentActivitySnapshot>,
    publishActivity: (snapshot: AgentActivitySnapshot) =>
        ipcRenderer.invoke('agent-os:publish-activity', snapshot) as Promise<AgentActivitySnapshot>,
    openPetWindow: () =>
        ipcRenderer.invoke('agent-os:open-pet-window') as Promise<{ ok: boolean }>,
    focusView: (view: 'assistant' | 'system-settings') =>
        ipcRenderer.invoke('agent-os:focus-view', view) as Promise<{ ok: boolean }>,
    setPetMenuOpen: (open: boolean) =>
        ipcRenderer.invoke('agent-os:set-pet-menu-open', open) as Promise<{ ok: boolean; offsetX?: number; offsetY?: number }>,
    setPetMousePassthrough: (passthrough: boolean) =>
        ipcRenderer.invoke('agent-os:set-pet-mouse-passthrough', passthrough) as Promise<{ ok: boolean }>,
    setPetMouseCapture: (capture: boolean) =>
        ipcRenderer.invoke('agent-os:set-pet-mouse-capture', capture) as Promise<{ ok: boolean }>,
    setPetHitRegions: (regions: Array<{ x: number; y: number; width: number; height: number }>) =>
        ipcRenderer.invoke('agent-os:set-pet-hit-regions', regions) as Promise<{ ok: boolean }>,
    movePetWindowBy: (delta: { dx: number; dy: number }) =>
        ipcRenderer.invoke('agent-os:move-pet-window-by', delta) as Promise<{ ok: boolean }>,
    onFocusView: (cb: (view: 'assistant' | 'system-settings') => void) => {
        const handler = (_e: unknown, view: 'assistant' | 'system-settings') => cb(view);
        ipcRenderer.on('agent-os:focus-view', handler);
        return () => ipcRenderer.removeListener('agent-os:focus-view', handler);
    },
    onActivity: (cb: (snapshot: AgentActivitySnapshot) => void) => {
        const handler = (_e: unknown, snapshot: AgentActivitySnapshot) => cb(snapshot);
        ipcRenderer.on('agent-os:activity', handler);
        return () => ipcRenderer.removeListener('agent-os:activity', handler);
    },
    onPetRendererError: (cb: (payload: AgentPetRendererErrorPayload) => void) => {
        const handler = (_e: unknown, payload: AgentPetRendererErrorPayload) => cb(payload);
        ipcRenderer.on('agent-os:pet-renderer-error', handler);
        return () => ipcRenderer.removeListener('agent-os:pet-renderer-error', handler);
    },
});

// Tag <html> with classes the renderer CSS can use to cope with Electron
// chrome differences — most importantly to push UI down on macOS so the
// frameless-window traffic lights don't overlap top-left content.
//
// Runs in the preload's isolated world but DOM access works because the
// document is already created by the time preload executes. We touch
// documentElement (not body) so the class is in place BEFORE React renders
// (no FOUC).
window.addEventListener('DOMContentLoaded', () => {
    const html = document.documentElement;
    html.classList.add('is-electron');
    if (process.platform === 'darwin') html.classList.add('is-electron-mac');
    if (process.platform === 'win32') html.classList.add('is-electron-win');
    if (process.platform === 'linux') html.classList.add('is-electron-linux');
});

// Type augmentation for renderer code (kept here so the preload contract and
// the renderer-visible shape never drift). Imported via `electron/preload.d.ts`
// reference if/when the renderer starts using `window.bambook`.
export type BambookBridge = {
    platform: NodeJS.Platform;
    versions: { electron: string; chrome: string; node: string };
};

export type BambookWindowBridge = {
    setTrafficLights: (visible: boolean) => Promise<void>;
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    isFullScreen: () => Promise<boolean>;
    onFullScreenChange: (cb: (fs: boolean) => void) => () => void;
};

export type BambookInvoiceBridge = {
    savePdf: (html: string, filename: string) => Promise<{ path: string }>;
};

export type BambookNotificationBridge = {
    showNative: (payload: { title: string; body?: string; link?: string }) => Promise<{ ok: boolean; reason?: string }>;
    onOpenLink: (cb: (link: string) => void) => () => void;
};

export type BambookDbBridge = {
    getPath: () => Promise<string>;
    listOrders: () => Promise<unknown[]>;
    listRelations: () => Promise<unknown[]>;
    saveRelation: (relation: unknown) => Promise<unknown>;
    deleteRelation: (id: string) => Promise<unknown>;
};

export type BambookServerBridge = {
    health: (host: string, port: number) => Promise<{ ok: boolean; ms?: number }>;
    startEmbedded: () => Promise<{ started: boolean }>;
    stopEmbedded: () => Promise<{ stopped: boolean }>;
};



export type LocalSttModelStatus = {
    exists: boolean;
    dir: string;
    files?: Record<string, string>;
};

export type LocalSttStatusResult = {
    ok: boolean;
    platform: NodeJS.Platform;
    arch: string;
    sherpaVersion?: string;
    activeSessions: number;
    model: LocalSttModelStatus;
    error?: string;
};

export type LocalSttPrepareResult = {
    ok: boolean;
    sherpaVersion?: string;
    model?: Pick<LocalSttModelStatus, 'dir' | 'exists'>;
    error?: string;
};

export type LocalSttStartResult = {
    ok: boolean;
    sessionId?: string;
    sampleRate?: number;
    error?: string;
};

export type LocalSttPushResult = {
    ok: boolean;
    text?: string;
    isEndpoint?: boolean;
    isFinal?: boolean;
    error?: string;
};

export type LocalSttFinishResult = {
    ok: boolean;
    text?: string;
    isFinal?: boolean;
    error?: string;
};

export type BambookLocalSTTBridge = {
    status: () => Promise<LocalSttStatusResult>;
    prepare: () => Promise<LocalSttPrepareResult>;
    start: () => Promise<LocalSttStartResult>;
    pushPcm: (sessionId: string, pcm: ArrayBuffer, sampleRate: number) => Promise<LocalSttPushResult>;
    finish: (sessionId: string) => Promise<LocalSttFinishResult>;
    stop: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
};

export type BambookAgentBridge = {
    getActivity: () => Promise<AgentActivitySnapshot>;
    publishActivity: (snapshot: AgentActivitySnapshot) => Promise<AgentActivitySnapshot>;
    openPetWindow: () => Promise<{ ok: boolean }>;
    focusView: (view: 'assistant' | 'system-settings') => Promise<{ ok: boolean }>;
    setPetMenuOpen: (open: boolean) => Promise<{ ok: boolean; offsetX?: number; offsetY?: number }>;
    setPetMousePassthrough: (passthrough: boolean) => Promise<{ ok: boolean }>;
    setPetMouseCapture: (capture: boolean) => Promise<{ ok: boolean }>;
    setPetHitRegions: (regions: Array<{ x: number; y: number; width: number; height: number }>) => Promise<{ ok: boolean }>;
    movePetWindowBy: (delta: { dx: number; dy: number }) => Promise<{ ok: boolean }>;
    onFocusView: (cb: (view: 'assistant' | 'system-settings') => void) => () => void;
    onActivity: (cb: (snapshot: AgentActivitySnapshot) => void) => () => void;
    onPetRendererError: (cb: (payload: AgentPetRendererErrorPayload) => void) => () => void;
};
