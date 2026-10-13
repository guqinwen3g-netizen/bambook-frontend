import { parsePeerless } from './parsers/peerless';
import { ParsedOrder } from './types';

export type CustomerParser = (text: string) => ParsedOrder;

export const parsersByCustomer: Record<string, CustomerParser> = {
  peerless: parsePeerless,
};
