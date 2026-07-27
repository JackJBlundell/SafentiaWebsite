// ============================================================================
// Curated UK fire-safety regulation reference (the source of truth for citations).
//
// THIS is the guardrail: every regulation a finding is tied to comes from this
// hand-maintained table of REAL UK instruments and standards - never from a model
// that could invent a plausible-looking article or BS number. The deterministic
// extractor maps a non-conformity to the most specific instrument by keyword; the
// AI summary is only ever given citations that originated here.
//
// Scope: England (the Regulatory Reform (Fire Safety) Order 2005 regime, as
// amended by the Fire Safety Act 2021 and supplemented by the Fire Safety
// (England) Regulations 2022). Scotland (Fire (Scotland) Act 2005) and Northern
// Ireland have separate regimes and are intentionally out of scope here.
//
// Keep entries accurate and current. Order matters: the FIRST matching keyword
// wins, so list the more specific topics before the general ones.
// ============================================================================

interface RegulationRule {
  /** Topic keywords (matched case-insensitively against the question + finding). */
  readonly match: RegExp;
  /** The real UK regulation/standard the topic engages. */
  readonly cite: string;
}

const REGULATION_RULES: readonly RegulationRule[] = [
  {
    match: /\b(alarm|detection|detector|smoke det|heat det|aspirat|call point|sounder|panel)\b/i,
    cite: 'Fire Safety Order 2005, art. 13 (fire detection & warning); BS 5839-1:2017',
  },
  {
    match: /\b(extinguisher|hose reel|fire blanket)\b/i,
    cite: 'Fire Safety Order 2005, art. 13 (firefighting); BS 5306-3 & BS 5306-8',
  },
  {
    match: /\b(emergency light|escape light|luminaire|borrowed light)\b/i,
    cite: 'Fire Safety Order 2005, art. 14 (emergency routes & exits); BS 5266-1:2016',
  },
  {
    match: /\b(fire door|door closer|intumescent|smoke seal|self-clos)\b/i,
    cite: 'Fire Safety Order 2005, art. 17 (maintenance); BS 8214 & fire door inspection',
  },
  {
    match: /\b(escape|exit|travel distance|stair|corridor|final exit|means of escape|protected route)\b/i,
    cite: 'Fire Safety Order 2005, art. 14 (emergency routes & exits); BS 9999 / Approved Document B',
  },
  {
    match: /\b(sign|signage|notice|wayfinding|photoluminescent)\b/i,
    cite: 'Health and Safety (Safety Signs and Signals) Regs 1996; BS 5499 / ISO 7010',
  },
  {
    match: /\b(training|drill|marshal|warden|evacuat|fire plan|peep|geep)\b/i,
    cite: 'Fire Safety Order 2005, arts. 15 & 21 (procedures & training)',
  },
  {
    match: /\b(sprinkler|suppress|water mist|misting)\b/i,
    cite: 'Fire Safety Order 2005, art. 13 (firefighting); BS EN 12845 / BS 9251',
  },
  {
    match: /\b(riser|dry riser|wet riser|firefighting shaft|firefighting lift|hydrant)\b/i,
    cite: 'Fire Safety Order 2005, art. 38 (facilities for firefighters); BS 9990',
  },
  {
    match: /\b(smoke control|ventilat|aov|smoke vent|smoke shaft)\b/i,
    cite: 'Fire Safety Order 2005, art. 17 (maintenance); BS 7346 / Approved Document B',
  },
  {
    match: /\b(electric|wiring|pat\b|portable appliance|consumer unit|distribution board|fixed wiring)\b/i,
    cite: 'Electricity at Work Regs 1989; BS 7671 (IET Wiring Regulations)',
  },
  {
    match: /\b(flammab|combustib|storage|housekeep|rubbish|waste|ignition|arson|dangerous substance|lpg|gas cylinder)\b/i,
    cite: 'Fire Safety Order 2005, arts. 10–12 (prevention); DSEAR 2002',
  },
  {
    match: /\b(external wall|cladding|balcon|render|insulation|compartment|fire stopping|penetration|cavity)\b/i,
    cite: 'Fire Safety Act 2021; Fire Safety Order 2005, art. 8 (general fire precautions)',
  },
  {
    match: /\b(secure information box|premises information box|wayfinding signage|flat entrance door|high-rise|high rise)\b/i,
    cite: 'Fire Safety (England) Regulations 2022',
  },
  {
    match: /\b(maintenance|servic|inspect|test|record|log book|logbook|certificate|competent person)\b/i,
    cite: 'Fire Safety Order 2005, art. 17 (maintenance) & art. 18 (competent person)',
  },
  {
    match: /\b(risk assessment|fra\b|review|significant finding)\b/i,
    cite: 'Fire Safety Order 2005, art. 9 (risk assessment)',
  },
];

/** The catch-all when no topic keyword matches: the primary duty under the Order. */
const DEFAULT_CITATION =
  'Regulatory Reform (Fire Safety) Order 2005 (general fire precautions)';

/**
 * Map a finding to the real UK regulation/standard it engages, by keyword over
 * the supplied texts (question wording + the assessor's observation). Returns the
 * first matching rule's citation, or the general duty under the Order. NEVER
 * invents a citation - every result is one of the curated strings above.
 */
export function regulationFor(...texts: Array<string | undefined>): string {
  const haystack = texts.filter(Boolean).join(' ');
  for (const rule of REGULATION_RULES) {
    if (rule.match.test(haystack)) {
      return rule.cite;
    }
  }
  return DEFAULT_CITATION;
}

/** The framework summary handed to the AI as grounding context (real instruments
 *  only). Kept here so the citation table and the AI's worldview cannot drift. */
export const UK_FIRE_SAFETY_FRAMEWORK = [
  'Legal framework (England):',
  '- Regulatory Reform (Fire Safety) Order 2005 ("the Fire Safety Order"): the',
  '  primary duty. Key articles - art. 9 (suitable & sufficient risk assessment),',
  '  art. 11 (fire safety arrangements), art. 13 (firefighting & fire detection),',
  '  art. 14 (emergency routes & exits), art. 15 (procedures for serious danger),',
  '  art. 17 (maintenance), art. 18 (competent person), art. 21 (training),',
  '  art. 38 (facilities for firefighters).',
  '- Fire Safety Act 2021: confirms the Order covers a building’s structure,',
  '  external walls (including cladding and balconies) and flat entrance doors in',
  '  multi-occupied residential buildings.',
  '- Fire Safety (England) Regulations 2022: duties in multi-occupied residential',
  '  buildings (e.g. fire door checks, wayfinding signage, secure information',
  '  boxes, evacuation information).',
  '',
  'Methodology: PAS 79-1:2020 (non-domestic) / PAS 79-2:2020 (residential common',
  'parts) - a risk-based, prioritised assessment.',
  '',
  'Supporting standards by topic: BS 5839-1 (fire detection & alarm),',
  'BS 5306-3/-8 (extinguishers), BS 5266-1 (emergency lighting), BS 9999 / BS 9991',
  'and Approved Document B (means of escape & building fire safety), BS 8214 (fire',
  'doors), BS 5499 / ISO 7010 (safety signs), BS 9990 (firefighting water systems),',
  'BS 7671 with the Electricity at Work Regs 1989 (electrical), DSEAR 2002',
  '(dangerous substances).',
].join('\n');
