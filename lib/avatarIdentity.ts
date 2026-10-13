export const ANIMATED_AVATAR_FAMILIES = new Set(['blobs', 'glass', 'squircles', 'waves', 'critters', 'thumbs', 'landscape', 'gaze', 'pixelbot', 'planets']);
const presetPattern = /^dicebear:v1:(blobs|disco|glass|glyphs|squircles|slice|waves|weave|critters|cameo|line-face|thumbs|landscape|croodles-neutral|dylan|fun-emoji|gaze|pixelbot|rings|stripes|planets):([A-Za-z0-9_-]{1,80}):(animated|still)$/;

export function parseAvatarIdentity(value?: string | null) {
  const match = value?.match(presetPattern);
  return match ? { family: match[1], seed: match[2], animated: match[3] === 'animated' } : null;
}

export function avatarIdentity(family: string, seed: string, animated: boolean) {
  return `dicebear:v1:${family}:${seed}:${animated ? 'animated' : 'still'}`;
}
