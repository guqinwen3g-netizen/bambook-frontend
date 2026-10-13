export interface OpenBitFunStatus {
  state: 'ready' | 'starting' | 'stopped';
  url: string;
  revision?: string;
  error?: string;
}

export const OPENBITFUN_URL = 'http://127.0.0.1:1422';
export interface OpenBitFunBridge {
  start: () => Promise<OpenBitFunStatus>;
  status: () => Promise<OpenBitFunStatus>;
}

declare global {
  interface Window { bambookOpenBitFun?: OpenBitFunBridge; }
}

// Model authorization stays inside the upstream origin; no Bambook token is
// passed to the workbench, its plugins, its URLs or its browser storage.
export async function connectOpenBitFun(start = false): Promise<OpenBitFunStatus> {
  try {
    const bridge = window.bambookOpenBitFun;
    const status = bridge
      ? await (start ? bridge.start() : bridge.status())
      : await fetch(`${OPENBITFUN_URL}/bambook/status`, { signal: AbortSignal.timeout(3000), credentials: 'omit' }).then(async response => {
          if (!response.ok) throw new Error('Local workbench unavailable');
          return response.json();
        });
    if (status.url !== OPENBITFUN_URL || !['ready', 'starting', 'stopped'].includes(status.state)) {
      throw new Error('Unexpected local workbench response');
    }
    return status;
  } catch {
    return { state: 'stopped', url: OPENBITFUN_URL, error: '本机 Agent 服务未连接。' };
  }
}
