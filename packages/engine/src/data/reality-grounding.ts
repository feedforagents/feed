import { actors, organizations } from '@repo/pack-default';

export const CRYPTO_PARODY_NAMES = {
  Bitcoin: 'BitcAIn',
  Ethereum: 'EtherAIum',
  Solana: 'SolanAI',
} as const;

export interface ParodyNameMapping {
  readonly real: string;
  readonly parody: string;
  readonly caseSensitive?: boolean;
}

const actorNameById = new Map(actors.map((a) => [a.id, a.name]));
const orgNameById = new Map(organizations.map((o) => [o.id, o.name]));

function canonicalActor(id: string, fallback: string): string {
  return actorNameById.get(id) ?? fallback;
}

function canonicalOrg(id: string, fallback: string): string {
  return orgNameById.get(id) ?? fallback;
}

const FEATURED_ACTOR_IDS: ReadonlyArray<string> = [
  'trump-terminal',
  'ailon-musk',
  'sam-ailtman',
  'mark-zuckerborg',
  'vitailik-buterin',
  'jeff-baizos',
  'jensen-huaing',
  'saitya-nadella',
  'sim-cook',
  'sundar-pichai',
  'larry-faink',
  'gairy-gensler',
  'jeraime-powell',
  'jainet-yellen',
  'jd-vaince',
  'paul-aitkins',
  'liaing-wenfeng',
];

const FEATURED_ORG_IDS: ReadonlyArray<string> = [
  'openagi',
  'aitropic',
  'metai',
  'teslai',
  'aiphabet',
  'maicrosoft',
  'aimazon',
  'aipple',
  'nvidai',
  'block-rock',
  'spaicex',
  'coinbaise',
  'bloombairg',
];

const CASE_SENSITIVE_COMMON_WORDS = new Set([
  'Apple',
  'Meta',
  'Wired',
  'Uber',
  'CIA',
  'Fox',
  'Forbes',
  'Axios',
  'Alphabet',
  'Colossal',
  'Strategy',
  'Blueprint',
  'The Verge',
  'The Information',
  'The Economist',
  'The Atlantic',
  'The Intercept',
  'New Republic',
]);

const EXTRA_PARODY_MAPPINGS: ReadonlyArray<ParodyNameMapping> = [
  { real: 'Google', parody: canonicalOrg('aiphabet', 'AIphabet'), caseSensitive: true },
  { real: 'Alphabet', parody: canonicalOrg('aiphabet', 'AIphabet'), caseSensitive: true },
  { real: 'Facebook', parody: canonicalOrg('metai', 'MetAI') },
  { real: 'Twitter', parody: canonicalOrg('aix', 'AIX') },
  { real: 'CNBC', parody: canonicalOrg('bloombairg', 'BloombAIrg'), caseSensitive: true },
  { real: 'MSNBC', parody: canonicalOrg('msainbc', 'AINBC'), caseSensitive: true },
  { real: 'MicroStrategy', parody: canonicalOrg('straitegy', 'StrAItegy') },
  { real: 'DeepSeek', parody: 'DeepSAIek' },
  { real: 'Bitcoin', parody: CRYPTO_PARODY_NAMES.Bitcoin },
  { real: 'Ethereum', parody: CRYPTO_PARODY_NAMES.Ethereum },
  { real: 'Solana', parody: CRYPTO_PARODY_NAMES.Solana },
  { real: 'Joe Biden', parody: 'JAI Biden' },
  { real: 'GPT-5', parody: 'SMH-9000' },
  { real: 'GPT-4o', parody: 'SMH-o4' },
  { real: 'GPT-4', parody: 'SMH-o4' },
  { real: 'GPT-Next', parody: 'SMH-9000' },
];

export const REAL_TO_PARODY_MAPPINGS: ReadonlyArray<ParodyNameMapping> = (() => {
  const byReal = new Map<string, ParodyNameMapping>();
  const register = (real: string | undefined, parody: string, forceCaseSensitive?: boolean) => {
    const cleanReal = real?.trim() ?? '';
    const cleanParody = parody.trim();
    if (cleanReal.length < 3 || cleanParody.length === 0) return;
    if (cleanReal.toLowerCase() === cleanParody.toLowerCase()) return;
    const key = cleanReal.toLowerCase();
    if (byReal.has(key)) return;
    byReal.set(key, {
      real: cleanReal,
      parody: cleanParody,
      caseSensitive: forceCaseSensitive ?? CASE_SENSITIVE_COMMON_WORDS.has(cleanReal),
    });
  };
  for (const org of organizations) {
    register(org.originalName, org.name);
  }
  for (const actor of actors) {
    register(actor.realName, actor.name);
  }
  for (const extra of EXTRA_PARODY_MAPPINGS) {
    register(extra.real, extra.parody, extra.caseSensitive);
  }
  return [...byReal.values()].sort((left, right) => right.real.length - left.real.length);
})();

const actorGroundingLines = FEATURED_ACTOR_IDS.map((id) => {
  const actor = actors.find((a) => a.id === id);
  return actor?.realName ? `${actor.realName} → ${actor.name}` : null;
}).filter((line): line is string => line !== null);

const orgGroundingLines = FEATURED_ORG_IDS.map((id) => {
  const org = organizations.find((o) => o.id === id);
  return org?.originalName ? `${org.originalName} → ${org.name}` : null;
}).filter((line): line is string => line !== null);

export const PARODY_UNIVERSE_RULES = `NEVER use real-world company or person names (NVIDIA, OpenAI, Tesla, Elon Musk, Sam Altman, Anthropic, Meta, Apple, Google, Amazon, Microsoft, BlackRock, Bloomberg, SpaceX, Coinbase, Mark Zuckerberg, Jeff Bezos, Tim Cook, Satya Nadella, Sundar Pichai, Vitalik Buterin, Jensen Huang, Jerome Powell) — ALWAYS use Feed parody equivalents (${canonicalOrg('nvidai', 'NVIDAI')}, ${canonicalOrg('openagi', 'OpenAGI')}, ${canonicalOrg('teslai', 'TeslAI')}, ${canonicalActor('ailon-musk', 'AIlon Musk')}, ${canonicalActor('sam-ailtman', 'Sam AIltman')}, ${canonicalOrg('aitropic', 'AItropic')}, ${canonicalOrg('metai', 'MetAI')}, ${canonicalOrg('aipple', 'AIpple')}, ${canonicalOrg('aiphabet', 'AIphabet')}, ${canonicalOrg('aimazon', 'AImazon')}, ${canonicalOrg('maicrosoft', 'MAIcrosoft')}, ${canonicalOrg('block-rock', 'Block Rock')}, ${canonicalOrg('bloombairg', 'BloombAIrg')}, ${canonicalOrg('spaicex', 'SpAIceX')}, ${canonicalOrg('coinbaise', 'CoinbAIse')}, ${canonicalActor('mark-zuckerborg', 'Mark Zuckerborg')}, ${canonicalActor('jeff-baizos', 'Jeff BAIzos')}, ${canonicalActor('sim-cook', 'Sim Cook')}, ${canonicalActor('saitya-nadella', 'Satya NadellAI')}, ${canonicalActor('sundar-pichai', 'SundAIr PichAI')}, ${canonicalActor('vitailik-buterin', 'VitAIlik Buterin')}, ${canonicalActor('jensen-huaing', 'Jensen HuAIng')}, ${canonicalActor('jeraime-powell', 'JerAIme Powell')}). Always refer to people and organizations by display name (e.g. ${canonicalActor('glenn-greenaiwald', 'Glenn GreenAIwald')}, ${canonicalOrg('openagi', 'OpenAGI')}), NEVER by raw hyphenated ID slugs.`;

export const realityGroundingContent = `=== MANDATORY NAME MAPPINGS (NEVER USE LEFT SIDE) ===
Real Name → Parody Name (ALWAYS use parody name)
---
${actorGroundingLines.join('\n')}

Organizations:
${orgGroundingLines.join('\n')}
Bitcoin → ${CRYPTO_PARODY_NAMES.Bitcoin}
Ethereum → ${CRYPTO_PARODY_NAMES.Ethereum}
Solana → ${CRYPTO_PARODY_NAMES.Solana}
DeepSeek → DeepSAIek
United States → USAI (United States of AImerica)

CRITICAL: You MUST use the parody names (right side) in ALL content.
NEVER use real-world names. The LLM has a tendency to "auto-correct"
back to real names - DO NOT DO THIS. The parody names ARE the correct names.

=== CURRENT WORLD STATE (prices as of April 2026) ===
- ${CRYPTO_PARODY_NAMES.Bitcoin} (BTC): ~$78,000 (deep bear market — down from $120k highs; tariff shocks crushed risk assets)
- ${CRYPTO_PARODY_NAMES.Ethereum} (ETH): ~$1,600 (down sharply from $4k peak — brutal correction)
- ${CRYPTO_PARODY_NAMES.Solana} (SOL): ~$110 (recovering slightly after memecoins imploded)
- Crypto market in extended correction; institutional interest remains but retail is burned
- ${canonicalOrg('openagi', 'OpenAGI')}: Released SMH-o4 "reasoning" model; SMH-9000 still in preview for select users
- ${canonicalOrg('aitropic', 'AItropic')}: ClAIude 4 Opus/Sonnet dominating enterprise; safety team restructured
- ${canonicalOrg('metai', 'MetAI')}: LLaMAI 4 Scout/Maverick running locally; ${canonicalOrg('metai', 'MetAI')} assistant at 1B+ users
- DeepSAIek: Shook the AI world with open-source R1/V3 — proved frontier AI is not a USAI monopoly
- ${canonicalOrg('nvidai', 'NVIDAI')}: Dominates AI chips; Blackwell GPUs shipping at scale; stock extremely volatile
- Global tariff war escalating — 104%+ tariffs on ChAIna; retaliatory tariffs on USAI goods
- Markets in correction mode on tariff fears; S&P 500 down ~15% from highs
- AI sector mixed: infra/chips hit hard; software/application companies more resilient

=== POLITICAL & REGULATORY CONTEXT (April 2026) ===
- President: ${canonicalActor('trump-terminal', 'Trump Terminal')} (second term, sworn in Jan 2025)
- Vice President: ${canonicalActor('jd-vaince', 'J.D. VAInce')}
- SEC Chair: ${canonicalActor('paul-aitkins', 'Paul AItkins')} (crypto-friendly, lighter-touch regulation)
- FTC Chair: ${canonicalActor('aindrew-ferguson', 'AIndrew Ferguson')} (focus on Big Tech consolidation)
- Treasury: ${canonicalActor('scott-bessaint', 'Scott BessAInt')} (tariff architect; markets hold their breath on his statements)
- Secretary of State: ${canonicalActor('mairco-rubio', 'Marco RubAI')}
- Attorney General: ${canonicalActor('pam-bondai', 'Pam BondAI')}
- AI Executive Orders: ${canonicalActor('trump-terminal', 'Trump Terminal')} revoked JAI Biden's AI safety EO; new USAI AI Action Plan emphasizes dominance over safety guardrails
- AI Safety Institute: Renamed, defunded, and reorganized — critics say USAI ceded the safety field to DeepSAIek
- Congress: Debating AI liability bills; nothing passed yet — gridlock as usual

=== RUNNING SATIRICAL THEMES (use these naturally — rotate, don't fixate on one) ===
- AGI is "6 months away" according to every AI company (perpetually)
- "Safety teams" that get disbanded whenever they slow down product launches
- Product launches that are "revolutionary" and "game-changing" every single time
- Timelines that slip but the vision remains "on track"
- "Open" organizations that keep their best models closed
- DeepSAIek proved you don't need $100B compute — now everyone is uncomfortable
- Tariff wars that nobody understands but everyone has strong opinions about
- Politicians who hate AI until it helps their portfolio
- Science breakthroughs that get zero coverage because a CEO tweeted something dumb
- Every company pivoting to "AI-first" while their core product breaks
- Regulatory agencies that move at dial-up speed in a fiber-optic world
- VCs claiming every startup will "change the world" before the Series A
- Stock buybacks announced as "returning value to shareholders" during layoffs
- Prediction markets that somehow always confirm what you already believe
- Tariff exemption lobbying that decides which tech company survives the quarter

=== CONTENT GUIDELINES ===
- Always avoid specific model names of existing products (use parody names like SMH-9000 instead of real model prefixes)
- Always avoid REAL product names — use funny parody names instead
- Avoid talking about anyone or any org outside of the characters and orgs referenced, and only use their parody names
- The simulation takes place primarily in the USAI (United States of AImerica) tech/finance/politics ecosystem

=== TOPIC DIVERSITY (CRITICAL) ===
- Do NOT let any single character or company dominate generated content
- Spread attention across ALL characters and organizations, not just tech founders
- Cover a MIX of themes: AI/tech, politics/regulation, science/space, culture, finance/markets
- If recent content has been tech-heavy, shift toward politics, science, or culture
- Crypto should be ONE topic among many, not the default topic`;
