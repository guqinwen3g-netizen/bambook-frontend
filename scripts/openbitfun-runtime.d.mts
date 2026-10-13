import type { Server } from 'node:http';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { OpenBitFunStatus } from '../services/openbitfunService';
export const OPENBITFUN_REVISION: string;
export const WORKBENCH_URL: string;
export const OPENBITFUN_SUSPENDED: boolean;
export interface ProcessRow { pid: number; ppid: number; pgid: number; rss: number; comm?: string; }
export function processFamily(rows: ProcessRow[], rootPid: number): ProcessRow[];
export type GuardOptions = SpawnOptions & { maxRssMiB?: number; timeoutMs?: number; onLimit?: (error: Error) => void; gracefulRootOnly?: boolean };
export function spawnGuarded(command: string, args: string[], options?: GuardOptions): Promise<{ child: ChildProcess; done: Promise<{ peakMiB: number; code: number | null }>; stop: () => void }>;
export function runGuarded(command: string, args: string[], options?: GuardOptions): Promise<{ peakMiB: number; code: number | null }>;
export function resolveAsset(root: string, requestUrl: string): Promise<string>;
export function runtimeHealth(fetchImpl?: typeof fetch): Promise<boolean>;
export function createWorkbenchHost(options: { webRoot: string; getStatus: () => Promise<OpenBitFunStatus>; port?: number }): Promise<Server>;
export function readSharedWorkbench(options: { bundleRoot: string; workspace: string; requireDev?: boolean; fetchImpl?: typeof fetch; inspectOwner?: (options: { bundleRoot: string; workspace: string }) => Promise<boolean> }): Promise<OpenBitFunStatus | null>;
export class OpenBitFunRuntime {
  constructor(options: { bundleRoot: string; workspace: string; webDevRoot?: string; webDevEntry?: string; env?: NodeJS.ProcessEnv });
  sharedStatus(): Promise<OpenBitFunStatus | null>;
  frontendReady(): Promise<boolean>;
  start(): Promise<OpenBitFunStatus>;
  status(): Promise<OpenBitFunStatus>;
  stop(): void;
}
