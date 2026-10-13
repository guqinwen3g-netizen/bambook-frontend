import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const SERVER_ROOT = path.resolve(__dirname, '..');
const APP_ROOT = path.resolve(SERVER_ROOT, '..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env.local'), override: true });
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });
dotenv.config({ path: path.join(APP_ROOT, '.env.local') });

type WallpaperSeed = {
  id: string;
  title: string;
  group: '极简' | '自然' | '城市' | '动漫';
  source: string;
  sortOrder: number;
};

const WALLPAPER_SEEDS: WallpaperSeed[] = [
  { id: 'none', title: '经典渐变', group: '极简', source: '', sortOrder: 0 },
  { id: 'scifi', title: '蓝羽流光', group: '极简', source: 'public/wallpapers/wallhaven-4dqgvj.jpg', sortOrder: 10 },
  { id: 'wallhaven-e8ejjw', title: '蓝紫柔光', group: '极简', source: 'public/wallpapers/wallhaven-e8ejjw.jpg', sortOrder: 20 },
  { id: 'cyber', title: '赛博光束', group: '极简', source: 'public/wallpapers/wallhaven-1kqvwg.jpg', sortOrder: 30 },
  { id: 'aurora', title: '湖镜列车', group: '自然', source: 'public/wallpapers/wallhaven-yqxzqx.jpg', sortOrder: 100 },
  { id: 'wallhaven-48pwv2', title: '雪浪成墙', group: '自然', source: 'public/wallpapers/wallhaven-48pwv2.jpg', sortOrder: 110 },
  { id: 'wallhaven-6lw5ll', title: '雪峰流云', group: '自然', source: 'public/wallpapers/wallhaven-6lw5ll.jpg', sortOrder: 120 },
  { id: 'wallhaven-mdmrly', title: '碧浪卷心', group: '自然', source: 'public/wallpapers/wallhaven-mdmrly.jpg', sortOrder: 130 },
  { id: 'wallhaven-rqjrzq', title: '雾海灰潮', group: '自然', source: 'public/wallpapers/wallhaven-rqjrzq.jpg', sortOrder: 140 },
  { id: 'wallhaven-966ev1', title: '沪上暮光', group: '城市', source: 'public/wallpapers/wallhaven-966ev1.jpg', sortOrder: 200 },
  { id: 'image-5', title: '星落晚窗', group: '动漫', source: 'public/wallpapers/5.jpg', sortOrder: 300 },
  { id: 'wallhaven-gw2zpq', title: '暮野孤影', group: '动漫', source: 'public/wallpapers/wallhaven-gw2zpq.jpg', sortOrder: 310 },
];

const args = new Set(process.argv.slice(2));
const mode = args.has('--api') ? 'api' : 'direct';
const dryRun = args.has('--dry-run');
const forceNames = args.has('--force-names');
const endpointArg = process.argv.find(arg => arg.startsWith('--endpoint='));
const apiEndpoint = (endpointArg?.split('=').slice(1).join('=') || process.env.BAMBOOK_SYSTEM_ASSET_ENDPOINT || 'https://jiangsupanda.com/bambook').replace(/\/$/, '');
const fromArg = process.argv.find(arg => arg.startsWith('--from='));
const fromId = fromArg?.split('=').slice(1).join('=');

main().catch(error => {
  console.error('[wallpaper-system-assets] failed:', error);
  process.exit(1);
});

async function main() {
  validateSeeds();
  if (dryRun) {
    printPlan();
    return;
  }
  if (mode === 'api') {
    await uploadViaApi();
    return;
  }
  await writeDirectly();
}

function printPlan() {
  for (const seed of selectedSeeds()) {
    const target = seed.source ? `${seed.title}${path.extname(seed.source)}` : '(no file)';
    console.log(`${seed.sortOrder}\t${seed.group}\t${seed.id}\t${seed.title}\t${target}`);
  }
}

function validateSeeds() {
  const ids = new Set<string>();
  for (const seed of WALLPAPER_SEEDS) {
    if (ids.has(seed.id)) throw new Error(`Duplicate wallpaper id: ${seed.id}`);
    ids.add(seed.id);
    if (!seed.source) continue;
    const fullPath = path.join(APP_ROOT, seed.source);
    if (!fs.existsSync(fullPath)) throw new Error(`Missing source file: ${fullPath}`);
  }
}

async function uploadViaApi() {
  for (const seed of selectedSeeds()) {
    const formData = new FormData();
    formData.append('id', seed.id);
    formData.append('title', seed.title);
    formData.append('group', seed.group);
    formData.append('sortOrder', String(seed.sortOrder));
    formData.append('hidden', 'false');
    formData.append('forceMetadata', String(forceNames));
    if (seed.source) {
      const filePath = path.join(APP_ROOT, seed.source);
      const bytes = fs.readFileSync(filePath);
      const targetName = `${seed.title}${path.extname(filePath).toLowerCase()}`;
      formData.append('file', new Blob([bytes], { type: mimeTypeFor(filePath) }), targetName);
    }

    const response = await fetch(`${apiEndpoint}/api/v1/system-assets/wallpapers`, {
      method: 'POST',
      headers: apiHeaders(),
      body: formData,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${seed.id} upload failed: ${response.status} ${JSON.stringify(body)}`);
    console.log(`[api] ${seed.id} -> ${seed.title}`);
  }
}

async function writeDirectly() {
  const prisma = new PrismaClient();
  const uploadDir = process.env.BAMBOOK_UPLOAD_DIR || path.join(SERVER_ROOT, '..', 'uploads');
  const targetDir = path.join(uploadDir, 'system', 'wallpapers');
  fs.mkdirSync(targetDir, { recursive: true });
  try {
    for (const seed of selectedSeeds()) {
      const now = Date.now();
      let filePath: string | null = null;
      let fileName: string | null = null;
      let fileSize: number | null = null;
      let mimeType: string | null = null;
      if (seed.source) {
        const sourcePath = path.join(APP_ROOT, seed.source);
        const ext = path.extname(sourcePath).toLowerCase();
        fileName = `${seed.title}${ext}`;
        const targetPath = path.join(targetDir, fileName);
        fs.copyFileSync(sourcePath, targetPath);
        filePath = path.join('system', 'wallpapers', fileName);
        fileSize = fs.statSync(targetPath).size;
        mimeType = mimeTypeFor(sourcePath);
      }
      await (prisma as any).systemAsset.upsert({
        where: { id: seed.id },
        create: {
          id: seed.id,
          kind: 'wallpaper',
          title: seed.title,
          group: seed.group,
          filePath,
          fileName,
          mimeType,
          fileSize,
          sortOrder: seed.sortOrder,
          hidden: false,
          metadata: { migratedFrom: seed.source || null },
          createdAt: BigInt(now),
          updatedAt: BigInt(now),
          deletedAt: null,
        },
        update: {
          ...(forceNames ? { title: seed.title, group: seed.group, sortOrder: seed.sortOrder, hidden: false } : {}),
          filePath,
          fileName,
          mimeType,
          fileSize,
          metadata: { migratedFrom: seed.source || null },
          updatedAt: BigInt(now),
          deletedAt: null,
        },
      });
      console.log(`[direct] ${seed.id} -> ${seed.title}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

function selectedSeeds(): WallpaperSeed[] {
  if (!fromId) return WALLPAPER_SEEDS;
  const start = WALLPAPER_SEEDS.findIndex(seed => seed.id === fromId);
  if (start === -1) throw new Error(`Unknown --from id: ${fromId}`);
  return WALLPAPER_SEEDS.slice(start);
}

function apiHeaders(): Record<string, string> {
  // 顺序：服务端专用 key 优先。VITE_ 前缀会被 Vite 内联进前端产物（等同公开），
  // 服务端已不再接受它作为凭证（见 src/auth/apiKeySafety.ts），仅作最后兜底。
  const key = process.env.BAMBOOK_SDK_KEY || process.env.BAMBOOK_API_KEY || process.env.VITE_BAMBOOK_API_KEY || '';
  return key ? { 'X-Bambook-API-Key': key } : {};
}

function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}
