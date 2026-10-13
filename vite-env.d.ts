/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_UI_MODE: 'desktop' | 'mobile'
    readonly VITE_BAMBOOK_GLOBE_STYLE_URL?: string
    readonly VITE_BAMBOOK_GLOBE_REAL_BUILDINGS_URL?: string
    readonly VITE_BAMBOOK_GLOBE_REAL_BUILDINGS_SOURCE_LAYER?: string
    readonly VITE_BAMBOOK_GLOBE_BUILDING_OVERRIDES_URL?: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}

type BambookAgentActivitySnapshot = {
    active: boolean;
    source?: 'assistant' | 'pet-preview' | 'system';
    label?: string;
    detail?: string;
};

type BambookAgentPetRendererErrorPayload = {
    message: string;
    stack?: string;
    source?: string;
};

interface Window {
    webkitAudioContext?: typeof AudioContext;
    bambookLocalSTT?: {
        status: () => Promise<{
            ok: boolean;
            platform: string;
            arch: string;
            sherpaVersion?: string;
            activeSessions: number;
            model: { exists: boolean; dir: string; files?: Record<string, string> };
            error?: string;
        }>;
        prepare: () => Promise<{
            ok: boolean;
            sherpaVersion?: string;
            model?: { exists: boolean; dir: string };
            error?: string;
        }>;
        start: () => Promise<{ ok: boolean; sessionId?: string; sampleRate?: number; error?: string }>;
        pushPcm: (sessionId: string, pcm: ArrayBuffer, sampleRate: number) => Promise<{
            ok: boolean;
            text?: string;
            isEndpoint?: boolean;
            isFinal?: boolean;
            error?: string;
        }>;
        finish: (sessionId: string) => Promise<{ ok: boolean; text?: string; isFinal?: boolean; error?: string }>;
        stop: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
    };
    bambookAgent?: {
        getActivity: () => Promise<BambookAgentActivitySnapshot>;
        publishActivity: (snapshot: BambookAgentActivitySnapshot) => Promise<BambookAgentActivitySnapshot>;
        openPetWindow: () => Promise<{ ok: boolean }>;
        focusView: (view: 'assistant' | 'system-settings') => Promise<{ ok: boolean }>;
        setPetMenuOpen: (open: boolean) => Promise<{ ok: boolean; offsetX?: number; offsetY?: number }>;
        setPetMousePassthrough: (passthrough: boolean) => Promise<{ ok: boolean }>;
        setPetMouseCapture: (capture: boolean) => Promise<{ ok: boolean }>;
        setPetHitRegions: (regions: Array<{ x: number; y: number; width: number; height: number }>) => Promise<{ ok: boolean }>;
        movePetWindowBy: (delta: { dx: number; dy: number }) => Promise<{ ok: boolean }>;
        onFocusView: (cb: (view: 'assistant' | 'system-settings') => void) => () => void;
        onActivity: (cb: (snapshot: BambookAgentActivitySnapshot) => void) => () => void;
        onPetRendererError: (cb: (payload: BambookAgentPetRendererErrorPayload) => void) => () => void;
    };
}
