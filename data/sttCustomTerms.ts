export type SttCorrectionRule = {
  pattern: string;
  replacement: string;
};

export const STT_CUSTOM_TERMS = [
  'Bambook',
  'Peerless',
  'RECMAN',
  'SARTORIAL',
  'TTS',
  'STT',
  'Paraformer',
  'FunASR',
  'sherpa-onnx',
];

export const STT_CORRECTION_RULES: SttCorrectionRule[] = [
  { pattern: '\\bbambook\\b', replacement: 'Bambook' },
  { pattern: '\\bbamboo\\b', replacement: 'Bambook' },
  { pattern: '班 book', replacement: 'Bambook' },
  { pattern: '班布克', replacement: 'Bambook' },
  { pattern: '\\bpairless\\b', replacement: 'Peerless' },
  { pattern: '皮尔里斯', replacement: 'Peerless' },
  { pattern: '派里斯', replacement: 'Peerless' },
  { pattern: '\\brekman\\b', replacement: 'RECMAN' },
  { pattern: '\\brackman\\b', replacement: 'RECMAN' },
  { pattern: 'rec man', replacement: 'RECMAN' },
  { pattern: '\\bsaatorio\\b', replacement: 'SARTORIAL' },
  { pattern: '\\bsatorio\\b', replacement: 'SARTORIAL' },
  { pattern: '萨托瑞尔', replacement: 'SARTORIAL' },
  { pattern: 's t t', replacement: 'STT' },
  { pattern: 't t s', replacement: 'TTS' },
];
