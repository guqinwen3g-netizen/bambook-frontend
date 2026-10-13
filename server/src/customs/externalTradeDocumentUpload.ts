import multer from 'multer';
import { EXTERNAL_TRADE_DOCUMENT_MAX_BYTES } from './externalTradeDocumentArchiveService';

/** Busboy emits its parts limit as soon as the counted part reaches it. The
 * one-file constraint comes from files/single; fields remain explicitly zero. */
export const createExternalTradeDocumentUpload = () => multer({ storage: multer.memoryStorage(),
  limits: { fileSize: EXTERNAL_TRADE_DOCUMENT_MAX_BYTES, files: 1, fields: 0, parts: 2 } }).single('file');
