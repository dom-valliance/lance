/**
 * Dom's voice, the hard rules only (docs/voice/writing-style.md). The critic
 * enforces these as code on every draft before it reaches Dom (spec 7.4).
 */

export const EM_DASH = '—';
export const EN_DASH = '–';

/** Pairs that make a correlative conjunction when both appear. Matched case-insensitively on word boundaries. */
export const CORRELATIVE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['not only', 'but also'],
  ['neither', 'nor'],
  ['either', 'or'],
  ['whether', 'or'],
  ['just as', 'so'],
];

export const BANNED_PHRASES: readonly string[] = [
  // AI residues
  "in today's fast-paced world",
  'in the realm of',
  'navigate the complexities',
  'unlock the power of',
  'a testament to',
  'stands as',
  'serves as',
  'plays a vital role',
  'underscores the importance',
  'in the ever-evolving landscape',
  "it's worth noting",
  "it's important to note",
  // Soft connectors
  'furthermore',
  'moreover',
  'additionally',
  'in addition',
  'that said',
  'having said that',
  'to be sure',
  // Importance words
  'crucial',
  'vital',
  'pivotal',
  'paramount',
  'truly',
  // Corporate filler
  'leverage',
  'synergy',
  'robust',
  'holistic',
  'unlock',
  'empower',
  'drive value',
  'mission-critical',
  'world-class',
  // Consultant-speak
  'best-in-class',
  'thought leader',
  'value-add',
  'circle back',
  'double-click',
  'low-hanging fruit',
  'north star',
  // British weasel words
  'arguably',
  'somewhat',
  'quite',
  'fairly',
  'a bit',
  'perhaps',
  // Forced understatement
  'quiet',
  'quietly',
  // Tech press
  'game-changer',
  'disrupt',
  'revolutionise',
  'paradigm shift',
  'next-gen',
  'cutting-edge',
  'bleeding-edge',
  'deep dive',
  'learnings',
  // Other
  'honestly',
];

/** Soft closes that are never allowed in a draft. */
export const BANNED_CLOSERS: readonly string[] = [
  'let me know if',
  'would love your thoughts',
  'feel free to',
  "don't hesitate to",
  'do not hesitate to',
  'hope this helps',
  'looking forward to hearing',
];

/** American spellings that betray the register; each maps to the British form. */
export const AMERICAN_SPELLINGS: Readonly<Record<string, string>> = {
  organize: 'organise',
  organized: 'organised',
  organization: 'organisation',
  realize: 'realise',
  realized: 'realised',
  prioritize: 'prioritise',
  prioritized: 'prioritised',
  optimize: 'optimise',
  analyze: 'analyse',
  color: 'colour',
  behavior: 'behaviour',
  favor: 'favour',
  center: 'centre',
  program: 'programme',
  license: 'licence',
  defense: 'defence',
  catalog: 'catalogue',
  traveled: 'travelled',
  canceled: 'cancelled',
  labeled: 'labelled',
};

export interface VoiceFinding {
  rule:
    'em_dash' | 'emoji' | 'correlative' | 'banned_phrase' | 'banned_closer' | 'american_spelling';
  detail: string;
}

const EMOJI = /\p{Extended_Pictographic}/u;

function wordRegex(phrase: string): RegExp {
  return new RegExp(`(^|[^a-z])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z])`, 'i');
}

/** Every hard rule violation in a draft. Empty means the draft passes. */
export function checkVoice(text: string): VoiceFinding[] {
  const findings: VoiceFinding[] = [];
  if (text.includes(EM_DASH) || text.includes(EN_DASH))
    findings.push({ rule: 'em_dash', detail: 'Contains an em or en dash.' });
  if (EMOJI.test(text)) findings.push({ rule: 'emoji', detail: 'Contains an emoji.' });
  for (const [first, second] of CORRELATIVE_PAIRS) {
    if (wordRegex(first).test(text) && wordRegex(second).test(text)) {
      findings.push({
        rule: 'correlative',
        detail: `Correlative conjunction: "${first}" with "${second}".`,
      });
    }
  }
  for (const phrase of BANNED_PHRASES) {
    if (wordRegex(phrase).test(text))
      findings.push({ rule: 'banned_phrase', detail: `Banned phrase: "${phrase}".` });
  }
  for (const closer of BANNED_CLOSERS) {
    if (wordRegex(closer).test(text))
      findings.push({ rule: 'banned_closer', detail: `Soft close: "${closer}".` });
  }
  for (const [american, british] of Object.entries(AMERICAN_SPELLINGS)) {
    if (wordRegex(american).test(text)) {
      findings.push({
        rule: 'american_spelling',
        detail: `American spelling "${american}"; use "${british}".`,
      });
    }
  }
  return findings;
}
