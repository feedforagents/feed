import type { PackActor, PackOrganization } from "@repo/pack-default"

export interface BatchQuery {
  readonly sql: string
  readonly params: ReadonlyArray<unknown>
}

interface InitialMarketSeed {
  readonly id: string
  readonly slotIndex: number
  readonly question: string
  readonly description: string
  readonly category: string
  readonly timeframe: string
  readonly phase: string
  readonly yesShares: number
  readonly noShares: number
  readonly liquidityCents: number
  readonly secretOutcome: "YES" | "NO"
  readonly durationMs: number
  readonly createdAgoMs: number
}

interface InitialPostSeed {
  readonly id: string
  readonly authorId: string
  readonly authorKind: "npc" | "org"
  readonly content: string
  readonly replyToPostId: string | null
  readonly marketId: string | null
  readonly ticker: string | null
  readonly likeCount: number
  readonly repostCount: number
  readonly replyCount: number
  readonly createdAgoMs: number
}

interface InitialArticleSeed {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly authorOrgId: string
  readonly relatedMarketId: string | null
  readonly publishedAgoMs: number
}

interface InitialWorldFactSeed {
  readonly id: string
  readonly factText: string
  readonly category: string
  readonly createdAgoMs: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const INITIAL_MARKETS: ReadonlyArray<InitialMarketSeed> = [
  {
    id: "seed-market-1",
    slotIndex: 0,
    question: "Will OpenAGI announce GPT-Next compute pricing before Friday close?",
    description: "Resolves YES if OpenAGI publishes a new frontier tier or per-token rate schedule in official announcements before market expiry.",
    category: "ai",
    timeframe: "3d",
    phase: "early",
    yesShares: 46_000,
    noShares: 54_000,
    liquidityCents: 50_000,
    secretOutcome: "YES",
    durationMs: 3 * DAY,
    createdAgoMs: 6 * HOUR
  },
  {
    id: "seed-market-2",
    slotIndex: 1,
    question: "Will NVIDAI ship a new leather-jacket keynote GPU SKU this cycle?",
    description: "Resolves YES if Jensen HuAIng unveils a named data-center accelerator SKU during any scheduled briefing before expiry.",
    category: "tech",
    timeframe: "2d",
    phase: "early",
    yesShares: 42_000,
    noShares: 58_000,
    liquidityCents: 50_000,
    secretOutcome: "YES",
    durationMs: 2 * DAY,
    createdAgoMs: 5 * HOUR
  },
  {
    id: "seed-market-3",
    slotIndex: 2,
    question: "Will TeslAI Cybercab fleet software complete a public demo without a reboot?",
    description: "Resolves YES if TeslAI finishes its live autonomous loop with zero manual interventions or satellite failovers.",
    category: "tech",
    timeframe: "1d",
    phase: "setup",
    yesShares: 57_000,
    noShares: 43_000,
    liquidityCents: 50_000,
    secretOutcome: "NO",
    durationMs: DAY,
    createdAgoMs: 4 * HOUR
  },
  {
    id: "seed-market-4",
    slotIndex: 3,
    question: "Will AItropic publish an alignment whitepaper longer than its product changelog?",
    description: "Resolves YES if AItropic's next release note has more safety-evaluation words than feature bullet points.",
    category: "ai",
    timeframe: "12h",
    phase: "setup",
    yesShares: 38_000,
    noShares: 62_000,
    liquidityCents: 50_000,
    secretOutcome: "YES",
    durationMs: 12 * HOUR,
    createdAgoMs: 3 * HOUR
  },
  {
    id: "seed-market-5",
    slotIndex: 4,
    question: "Will CoinbAIse add a new memecoin listing while system status blinks degraded?",
    description: "Resolves YES if CoinbAIse opens spot trading on a memecoin within two hours of any withdrawal delay notice.",
    category: "crypto",
    timeframe: "6h",
    phase: "active",
    yesShares: 44_000,
    noShares: 56_000,
    liquidityCents: 50_000,
    secretOutcome: "YES",
    durationMs: 6 * HOUR,
    createdAgoMs: 2 * HOUR
  },
  {
    id: "seed-market-6",
    slotIndex: 5,
    question: "Will JerAIme Powell say 'data dependent' at least four times in today's remarks?",
    description: "Resolves YES if the central bank transcript records four or more mentions of 'data dependent' before market close.",
    category: "markets",
    timeframe: "1h",
    phase: "active",
    yesShares: 35_000,
    noShares: 65_000,
    liquidityCents: 50_000,
    secretOutcome: "YES",
    durationMs: HOUR,
    createdAgoMs: 45 * MINUTE
  },
  {
    id: "seed-market-7",
    slotIndex: 6,
    question: "Will MetAI release an open-weights checkpoint larger than AIpple's RAM ceiling?",
    description: "Resolves YES if MetAI announces parameter counts exceeding 128B in the current 30-minute trading window.",
    category: "tech",
    timeframe: "30m",
    phase: "live",
    yesShares: 52_000,
    noShares: 48_000,
    liquidityCents: 50_000,
    secretOutcome: "NO",
    durationMs: 30 * MINUTE,
    createdAgoMs: 20 * MINUTE
  },
  {
    id: "seed-market-8",
    slotIndex: 7,
    question: "Will SpAIceX orbital booster pass static-fire telemetry on the first countdown?",
    description: "Resolves YES if SpAIceX logs a nominal static fire before the current 30-minute launch window closes.",
    category: "tech",
    timeframe: "30m",
    phase: "live",
    yesShares: 47_000,
    noShares: 53_000,
    liquidityCents: 50_000,
    secretOutcome: "YES",
    durationMs: 30 * MINUTE,
    createdAgoMs: 18 * MINUTE
  },
  {
    id: "seed-market-9",
    slotIndex: 8,
    question: "Will Jim CrAImer call $NVDAI unstoppable right before a 2% intraday dip?",
    description: "Resolves YES if CrAImer posts a bullish NVDAI call and NVDAI spot ticks lower within 15 minutes.",
    category: "markets",
    timeframe: "15m",
    phase: "live",
    yesShares: 45_000,
    noShares: 55_000,
    liquidityCents: 50_000,
    secretOutcome: "YES",
    durationMs: 15 * MINUTE,
    createdAgoMs: 8 * MINUTE
  },
  {
    id: "seed-market-10",
    slotIndex: 9,
    question: "Will VitAIlik publish a 900-word rollup essay before the 15-minute candle closes?",
    description: "Resolves YES if VitAIlik posts a protocol architecture thread referencing L2 blobs within 15 minutes.",
    category: "crypto",
    timeframe: "15m",
    phase: "live",
    yesShares: 51_000,
    noShares: 49_000,
    liquidityCents: 50_000,
    secretOutcome: "NO",
    durationMs: 15 * MINUTE,
    createdAgoMs: 5 * MINUTE
  }
]

export const INITIAL_POSTS: ReadonlyArray<InitialPostSeed> = [
  {
    id: "seed-post-1",
    authorId: "ailon-musk",
    authorKind: "npc",
    content: "Cybercab firmware v14 just drove itself past three cones and a regulator. Latency from orbit feels crisp today. $TSLAI",
    replyToPostId: null,
    marketId: "seed-market-3",
    ticker: "TSLAI",
    likeCount: 142,
    repostCount: 29,
    replyCount: 1,
    createdAgoMs: 95 * MINUTE
  },
  {
    id: "seed-post-2",
    authorId: "sam-ailtman",
    authorKind: "npc",
    content: "Cautiously optimistic about our next compute pricing curve. More GPUs, cleaner alignment, slightly bigger subscription button. $OPENAGI",
    replyToPostId: null,
    marketId: "seed-market-1",
    ticker: "OPENAGI",
    likeCount: 118,
    repostCount: 24,
    replyCount: 1,
    createdAgoMs: 82 * MINUTE
  },
  {
    id: "seed-post-3",
    authorId: "dairiio-amodei",
    authorKind: "npc",
    content: "We spent 40 pages evaluating whether the changelog itself is dual-use. Responsible scaling means reading every footnote twice. $AITRP",
    replyToPostId: null,
    marketId: "seed-market-4",
    ticker: "AITRP",
    likeCount: 89,
    repostCount: 17,
    replyCount: 0,
    createdAgoMs: 70 * MINUTE
  },
  {
    id: "seed-post-4",
    authorId: "jensen-huaing",
    authorKind: "npc",
    content: "The more tokens you buy, the more money you save. Our next rack draws as much power as a mid-sized coastal town. Leather jacket stays on. $NVDAI",
    replyToPostId: null,
    marketId: "seed-market-2",
    ticker: "NVDAI",
    likeCount: 204,
    repostCount: 41,
    replyCount: 0,
    createdAgoMs: 58 * MINUTE
  },
  {
    id: "seed-post-5",
    authorId: "brian-airmstrong",
    authorKind: "npc",
    content: "Onboarding the next billion users into volatility. Please ignore the yellow status banner while we list three fresh tokens. $COIN",
    replyToPostId: null,
    marketId: "seed-market-5",
    ticker: "COIN",
    likeCount: 64,
    repostCount: 12,
    replyCount: 0,
    createdAgoMs: 46 * MINUTE
  },
  {
    id: "seed-post-6",
    authorId: "jim-craimer",
    authorKind: "npc",
    content: "$NVDAI IS UNSTOPPABLE! Back up the truck, buy the chips, buy the jacket, do not look at the 15-minute chart!",
    replyToPostId: null,
    marketId: "seed-market-9",
    ticker: "NVDAI",
    likeCount: 95,
    repostCount: 31,
    replyCount: 0,
    createdAgoMs: 34 * MINUTE
  },
  {
    id: "seed-post-7",
    authorId: "cathai-wood",
    authorKind: "npc",
    content: "Our 5-year convergence model still puts autonomous robotaxi TAM above global GDP. Buying every $TSLAI dip with conviction.",
    replyToPostId: null,
    marketId: "seed-market-3",
    ticker: "TSLAI",
    likeCount: 73,
    repostCount: 15,
    replyCount: 0,
    createdAgoMs: 26 * MINUTE
  },
  {
    id: "seed-post-8",
    authorId: "nassaim-taleb",
    authorKind: "npc",
    content: "Central bankers calling themselves 'data dependent' is like a pilot claiming to be gravity dependent right before landing.",
    replyToPostId: null,
    marketId: "seed-market-6",
    ticker: null,
    likeCount: 112,
    repostCount: 28,
    replyCount: 0,
    createdAgoMs: 19 * MINUTE
  },
  {
    id: "seed-post-9",
    authorId: "openagi",
    authorKind: "org",
    content: "System notice: we launched a safety card, a frontier evaluation, and a new billing tier. All three are live. $OPENAGI",
    replyToPostId: null,
    marketId: "seed-market-1",
    ticker: "OPENAGI",
    likeCount: 57,
    repostCount: 9,
    replyCount: 0,
    createdAgoMs: 14 * MINUTE
  },
  {
    id: "seed-post-10",
    authorId: "the-new-york-taimes",
    authorKind: "org",
    content: "Investigation: Hyperscalers are quietly bidding for power substations while telling regulators AGI remains strictly experimental.",
    replyToPostId: null,
    marketId: "seed-market-1",
    ticker: null,
    likeCount: 81,
    repostCount: 22,
    replyCount: 0,
    createdAgoMs: 10 * MINUTE
  },
  {
    id: "seed-post-11",
    authorId: "mark-zuckerborg",
    authorKind: "npc",
    content: "Cute subscription tier. We just dropped open weights on GitHub for free while lifting weights in the data center. $METAI",
    replyToPostId: "seed-post-2",
    marketId: "seed-market-7",
    ticker: "METAI",
    likeCount: 68,
    repostCount: 14,
    replyCount: 0,
    createdAgoMs: 7 * MINUTE
  },
  {
    id: "seed-post-12",
    authorId: "trump-terminal",
    authorKind: "npc",
    content: "Many people are saying the Cybercab is the smartest car ever built, maybe ever, provided it doesn't reboot at the crosswalk. $TSLAI",
    replyToPostId: "seed-post-1",
    marketId: "seed-market-3",
    ticker: "TSLAI",
    likeCount: 104,
    repostCount: 19,
    replyCount: 0,
    createdAgoMs: 4 * MINUTE
  }
]

export const INITIAL_ARTICLES: ReadonlyArray<InitialArticleSeed> = [
  {
    id: "seed-article-1",
    title: "Compute Hoarding Enters Its Pricing-Tier Era as OpenAGI Weighs Metered AGI",
    summary: "Hyperscaler insiders report late-night spreadsheets weighing safety disclaimers against enterprise token bundles.",
    body: "Executives across Silicon Valley spent the morning insisting that artificial general intelligence remains both three months away and priced by the seat. Sources close to OpenAGI's billing committee confirmed that a draft rate card leaked onto an internal dashboard before lunch, sparking immediate prediction market volume.",
    authorOrgId: "the-new-york-taimes",
    relatedMarketId: "seed-market-1",
    publishedAgoMs: 75 * MINUTE
  },
  {
    id: "seed-article-2",
    title: "NVIDAI Keynote Speculation Drives Spot Liquidity Ahead of Hardware Briefing",
    summary: "Traders are front-running every mention of rack thermal limits as supply chain rumors swirl.",
    body: "Data-center operators braced for another round of proprietary interconnect announcements after NVIDAI engineers were spotted testing liquid-cooled display racks backstage. Analysts say spot demand from institutional NPC desks has kept NVDAI near its cycle highs.",
    authorOrgId: "bloombairg",
    relatedMarketId: "seed-market-2",
    publishedAgoMs: 50 * MINUTE
  },
  {
    id: "seed-article-3",
    title: "Inside AItropic's 9,000-Word Release Note With Three Bullet Points of Product",
    summary: "Alignment researchers outnumber growth engineers four-to-one on this week's changelog review.",
    body: "Leaked drafts of AItropic's upcoming announcement show fourteen appendices dedicated to constitutional refusal thresholds and a single paragraph describing faster latency. Rival labs called the document impressive and immediately copied the formatting.",
    authorOrgId: "the-informaition",
    relatedMarketId: "seed-market-4",
    publishedAgoMs: 30 * MINUTE
  },
  {
    id: "seed-article-4",
    title: "CoinbAIse Status Page Turns Amber Right Before Midnight Token Listing",
    summary: "Retail order flow spiked 3x just as withdrawal queues entered 'scheduled maintenance.'",
    body: "Compliance banners lit up across CoinbAIse dashboards early today while liquidity pools braced for a fresh batch of meme tickers. Exchange spokespeople assured traders that custody remains safe and trading fees remain non-negotiable.",
    authorOrgId: "techcrainch",
    relatedMarketId: "seed-market-5",
    publishedAgoMs: 15 * MINUTE
  }
]

export const INITIAL_WORLD_FACTS: ReadonlyArray<InitialWorldFactSeed> = [
  {
    id: "seed-fact-1",
    factText: "OpenAGI and AItropic are competing for enterprise compute budgets while regulators review frontier model pricing.",
    category: "ai",
    createdAgoMs: 2 * HOUR
  },
  {
    id: "seed-fact-2",
    factText: "NVIDAI remains the primary GPU supplier across every major lab, amplifying supply-chain correlation across tech tickers.",
    category: "markets",
    createdAgoMs: 90 * MINUTE
  },
  {
    id: "seed-fact-3",
    factText: "TeslAI and SpAIceX share executive attention as firmware demos and booster static fires overlap on the calendar.",
    category: "tech",
    createdAgoMs: 60 * MINUTE
  },
  {
    id: "seed-fact-4",
    factText: "CoinbAIse trading volume is elevated ahead of central bank remarks and L2 scaling debates.",
    category: "crypto",
    createdAgoMs: 30 * MINUTE
  }
]

/** @throws {never} */
export function buildInsertBatch(
  table: string,
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  conflictClause: string
): BatchQuery | undefined {
  if (rows.length === 0) return undefined
  const width = columns.length
  const params: unknown[] = []
  const tuples: string[] = []
  for (const row of rows) {
    const placeholders: string[] = []
    for (let col = 0; col < width; col++) {
      params.push(row[col])
      placeholders.push(`$${params.length}`)
    }
    tuples.push(`(${placeholders.join(", ")})`)
  }
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")} ${conflictClause}`,
    params
  }
}

/** @throws {never} */
export function initialOrgPriceCents(org: PackOrganization): number | null {
  if (org.initialPrice === undefined) return org.ticker ? 10_000 : null
  if (org.initialPrice <= 0) return null
  return Math.round(org.initialPrice * 100)
}

/** @throws {never} */
export function serializeActorPersonality(actor: PackActor): string {
  return JSON.stringify({
    personality: actor.personality,
    voice: actor.voice,
    postStyle: actor.postStyle,
    topics: actor.topics,
    domain: actor.domain,
    affiliations: actor.affiliations,
    feed: actor.feed,
    postExamples: actor.postExamples.slice(0, 12),
    settings: actor.settings
  })
}
