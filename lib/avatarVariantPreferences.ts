/** Semantic variant names verified against the installed DiceBear JSON definitions.
 * Unlisted variants keep weight 1, and every named variant stays strictly positive.
 */
const energyProfiles: Record<string, Record<string, [string[], string[]]>> = {
  'line-face': { eyes: [['closed','sleepy','dots'],['happy','wink','winkRight','mismatch','unevenDots']], mouth: [['soft','line','shy'],['smile','smirk','wavy']] },
  critters: { eyes: [['dots','sleepy','closedLine','monoSleepy'],['wide','happy','wink','uneven','trio']], mouth: [['tinySmile','line','dot'],['grin','laugh','tongue','blep','open','teeth']] },
  cameo: { mouth: [['calm'],['grin','beam']], hair: [['cap','part','bowl'],['wave','curls']] },
  gaze: { eyes: [['small','dots','bars'],['big','shine','wide','happy','grin']] },
  pixelbot: { mouth: [['flat','tiny'],['bigSmile','open']], eyes: [['slim','soft'],['happy','wide']] },
  waves: { body: [['trio'],['quintet','sextet']], layer: [['calm','ripple'],['swell','surge']] },
  slice: { cuts: [['tri','quadPair'],['fiveKick','sixZig','sixStep','sixDeep']] },
};
export function avatarVariantPreferences(family: string, seed: string, components: Record<string, { variants?: Record<string, unknown> }>) {
  const match = seed.match(/^(?:p[0-5]_v[34]|c\d{1,3}_v5)_(\d+)_(\d+)_/);
  if (!match) return {};
  const energy = 1 - Number(match[2]) / 12;
  const options: Record<string, Record<string, number>> = {};
  for (const [component, [calm, lively]] of Object.entries(energyProfiles[family] || {})) {
    const variants = components[component]?.variants;
    if (!variants) continue;
    options[`${component}Variant`] = Object.fromEntries(Object.keys(variants).map(name => [name,
      Math.exp((lively.includes(name) ? 1 : calm.includes(name) ? -1 : 0) * energy * 2),
    ]));
  }
  return options;
}
