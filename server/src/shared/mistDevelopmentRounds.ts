/**
 * 开发轮次与固定工厂字母（BB-DEV-2）。
 * 轮次 = 一批共同开发要求，可派给任意数量的工厂；某轮某工厂的实体成果是大版本 R{轮次}-{字母}。
 * 工厂字母在本案首次参与时分配，之后固定不变；历史版本号（如 R1-A-1）按原样保留、只读。
 */
import type { MistDev, MistRound, MistState, MistVersion } from './mistWorkspace';

/** 第 n 个字母（0 → A，25 → Z，26 → AA）。 */
export function factoryLetterAt(index: number): string {
  let value = index + 1, result = '';
  while (value > 0) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
}

/** 历史版本号中的轮次号与工厂字母；新格式 R2-C 与旧格式 R1-A-1 / R4-A.1 都能读取。 */
export function parseVersionLabel(label: string): { round: number; letter: string } | null {
  const match = /^R(\d+)-([A-Z]+)(?:$|[-.])/.exec(label || '');
  return match ? { round: Number(match[1]), letter: match[2] } : null;
}

export const devVersions = (state: MistState, dev: MistDev): MistVersion[] =>
  dev.versionIds.map(id => state.versions.find(version => version.id === id)).filter((version): version is MistVersion => !!version);

export const devRounds = (state: MistState, devId: string): MistRound[] =>
  (state.rounds || []).filter(round => round.devId === devId).sort((a, b) => a.number - b.number);

/**
 * 本案已固定的工厂字母。新记录直接读取已保存的对照；旧案按版本建立顺序从历史版本号推导，
 * 推导只补缺，不改写已保存的字母。
 */
export function caseFactoryLetters(state: MistState, dev: MistDev): Record<string, string> {
  const letters: Record<string, string> = { ...(dev.factoryLetters || {}) };
  const used = new Set(Object.values(letters));
  for (const version of devVersions(state, dev)) {
    if (!version.factory || letters[version.factory]) continue;
    const letter = version.factoryLetter || parseVersionLabel(version.label)?.letter;
    if (letter && !used.has(letter)) { letters[version.factory] = letter; used.add(letter); }
  }
  return letters;
}

/** 为首次参与本案的工厂分配下一个未用字母；已参与的工厂沿用原字母。 */
export function assignFactoryLetters(state: MistState, dev: MistDev, factories: string[]): Record<string, string> {
  const letters = caseFactoryLetters(state, dev), used = new Set(Object.values(letters));
  for (const factory of factories) {
    if (letters[factory]) continue;
    let index = 0; while (used.has(factoryLetterAt(index))) index++;
    letters[factory] = factoryLetterAt(index); used.add(letters[factory]);
  }
  dev.factoryLetters = letters;
  return letters;
}

/** 下一轮轮次号：取本案已登记轮次与历史版本号中的最大轮次 + 1。 */
export function nextRoundNumber(state: MistState, dev: MistDev): number {
  const numbers = [0, ...devRounds(state, dev.id).map(round => round.number), ...devVersions(state, dev).map(version => parseVersionLabel(version.label)?.round || 0)];
  return Math.max(...numbers) + 1;
}

export const roundVersionLabel = (round: number, letter: string) => `R${round}-${letter}`;

/** 页面展示用：本案轮次（含按历史版本号归组、未登记轮次记录的旧轮次）。 */
export type DevelopmentRoundView = { number: number; round: MistRound | null; versions: MistVersion[] };
export function developmentRoundViews(state: MistState, dev: MistDev): DevelopmentRoundView[] {
  const rounds = devRounds(state, dev.id), views = new Map<number, DevelopmentRoundView>();
  for (const round of rounds) views.set(round.number, { number: round.number, round, versions: [] });
  for (const version of devVersions(state, dev)) {
    const round = version.roundId ? rounds.find(item => item.id === version.roundId) : undefined;
    const number = round?.number ?? parseVersionLabel(version.label)?.round ?? 0;
    if (!views.has(number)) views.set(number, { number, round: null, versions: [] });
    views.get(number)!.versions.push(version);
  }
  return [...views.values()].sort((a, b) => a.number - b.number);
}
