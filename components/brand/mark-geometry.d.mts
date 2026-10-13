export interface MarkCandidate {
  code: string;
  name: string;
  count: number;
  length: number;
  breadth: number;
  seam?: number;
  [key: string]: any;
}
export interface LeafGeometry {
  d: string;
  x: number;
  y: number;
  rotation: number;
  index: number;
  half: number;
  curve: number;
}
export const markCandidates: MarkCandidate[];
export function getLeafUnitGeometry(candidate: MarkCandidate, scale?: number): {d: string; points: {x: number; y: number}[]; half: number; curve: number};
export function getLeafGeometry(candidate: MarkCandidate): LeafGeometry[];
export function getKnotUnderCut(leaf: LeafGeometry, over: LeafGeometry): number;
export function exportMarkSvg(candidate: MarkCandidate, color?: string): string;
