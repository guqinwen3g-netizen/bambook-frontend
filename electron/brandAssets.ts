import path from 'node:path';

/** Same V3 raster for native windows and the Dock; install paths differ from dev. */
export function resolveBambookIconPath({ packaged, resourcesPath, mainDirectory }: {
  packaged: boolean; resourcesPath: string; mainDirectory: string;
}): string {
  return packaged
    ? path.join(resourcesPath, 'brand/bambook-v3.png')
    : path.resolve(mainDirectory, '../../build/bambook-v3.png');
}
