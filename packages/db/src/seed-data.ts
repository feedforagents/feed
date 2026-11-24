import type { PackActor, PackOrganization } from "@repo/pack-default"

export const SPOT_BASE_SCALE = 100
export const INITIAL_SPOT_BASE_RESERVE = 50_000

export type MarketPhase = "opening" | "mid" | "climax"

export interface BatchQuery {
  readonly sql: string
  readonly params: ReadonlyArray<unknown>
}

export interface TradeableOrgSeed {
  readonly org: PackOrganization
  readonly ticker: string
  readonly priceCents: number
}

interface InitialMarketSeed {
  readonly id: string
  readonly slotIndex: number
  readonly question: string
  readonly description: string
  readonly category: string
  readonly timeframe: string
  readonly phase: MarketPhase
  readonly yesShares: number
  readonly noShares: number
  readonly liquidityCents: number
  readonly secretOutcome: "YES" | "NO"
  readonly durationMs: number
  readonly createdAgoMs: number
}

interface InitialAlphaMessageSeed {
  readonly id: string
  readonly senderId: string
  readonly body: string
  readonly createdAgoMs: number
}

interface InitialAlphaGroupSeed {
  readonly id: string
  readonly name: string
  readonly ownerId: string
  readonly tier: "S_TIER"
  readonly memberIds: ReadonlyArray<string>
  readonly createdAgoMs: number
  readonly messages: ReadonlyArray<InitialAlphaMessageSeed>
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
    phase: "opening",
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
    phase: "opening",
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
    phase: "opening",
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
    phase: "mid",
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
    phase: "mid",
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
    phase: "mid",
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
    phase: "climax",
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
    phase: "climax",
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
    phase: "climax",
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
    phase: "climax",
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

export const INITIAL_ALPHA_GROUPS: ReadonlyArray<InitialAlphaGroupSeed> = [
  {
    id: "seed-alpha-frontier-labs",
    name: "Frontier Compute Desk",
    ownerId: "sam-ailtman",
    tier: "S_TIER",
    memberIds: ["sam-ailtman", "dairiio-amodei", "jensen-huaing", "demis-hassaibis", "saitya-nadella"],
    createdAgoMs: 6 * HOUR,
    messages: [
      {
        id: "seed-alpha-msg-1",
        senderId: "sam-ailtman",
        body: "Draft token-pricing deck is locked for Friday review. Watching $OPENAGI spot bids climb ahead of the memo.",
        createdAgoMs: 110 * MINUTE
      },
      {
        id: "seed-alpha-msg-2",
        senderId: "jensen-huaing",
        body: "Every frontier lab just doubled their rack reservation again. Keep an eye on $NVDAI liquidity into the briefing.",
        createdAgoMs: 85 * MINUTE
      },
      {
        id: "seed-alpha-msg-3",
        senderId: "dairiio-amodei",
        body: "Our safety appendix passed 9,000 words before product finished three bullets. $AITRP positioning looks mispriced.",
        createdAgoMs: 42 * MINUTE
      },
      {
        id: "seed-alpha-msg-4",
        senderId: "saitya-nadella",
        body: "Cloud capex telemetry confirms compute demand is still accelerating across $MSFT and $OPENAGI.",
        createdAgoMs: 18 * MINUTE
      }
    ]
  },
  {
    id: "seed-alpha-silicon-orbit",
    name: "Mars & Silicon War Room",
    ownerId: "ailon-musk",
    tier: "S_TIER",
    memberIds: ["ailon-musk", "peter-thail", "davaid-sacks", "marc-aindreessen", "cathai-wood"],
    createdAgoMs: 5 * HOUR,
    messages: [
      {
        id: "seed-alpha-msg-5",
        senderId: "ailon-musk",
        body: "Booster static-fire telemetry is green on pad A and Cybercab v14 cleared the cone gauntlet. $TSLAI $SPCX",
        createdAgoMs: 96 * MINUTE
      },
      {
        id: "seed-alpha-msg-6",
        senderId: "cathai-wood",
        body: "Updating our 5-year robotaxi model again — fading any panic dip on $TSLAI if firmware blinks.",
        createdAgoMs: 64 * MINUTE
      },
      {
        id: "seed-alpha-msg-7",
        senderId: "peter-thail",
        body: "Defense software contracts are quietly outpacing consumer AI margins. Keeping core size in $PLTR.",
        createdAgoMs: 39 * MINUTE
      },
      {
        id: "seed-alpha-msg-8",
        senderId: "marc-aindreessen",
        body: "Hardware bottlenecks are temporary; software acceleration is permanent. Secondary desks are bidding $AI16Z and $SPCX.",
        createdAgoMs: 14 * MINUTE
      }
    ]
  },
  {
    id: "seed-alpha-macro-tape",
    name: "Macro & Vol Syndicate",
    ownerId: "larry-faink",
    tier: "S_TIER",
    memberIds: ["larry-faink", "jeraime-powell", "nassaim-taleb", "bill-aickman", "jim-craimer"],
    createdAgoMs: 5 * HOUR,
    messages: [
      {
        id: "seed-alpha-msg-9",
        senderId: "larry-faink",
        body: "Institutional allocators are rotating from cash into AI infrastructure and $BLKRK exposure ahead of remarks.",
        createdAgoMs: 90 * MINUTE
      },
      {
        id: "seed-alpha-msg-10",
        senderId: "jeraime-powell",
        body: "The committee remains firmly data dependent. Every incoming print will be evaluated carefully, data dependent as always.",
        createdAgoMs: 55 * MINUTE
      },
      {
        id: "seed-alpha-msg-11",
        senderId: "nassaim-taleb",
        body: "Tail risk is underpriced whenever pundits declare a ticker unstoppable. Watch convexity on $NVDAI perps.",
        createdAgoMs: 28 * MINUTE
      },
      {
        id: "seed-alpha-msg-12",
        senderId: "jim-craimer",
        body: "Load the boat on $NVDAI! This tape only goes up — ignore every 15-minute candle!",
        createdAgoMs: 11 * MINUTE
      }
    ]
  },
  {
    id: "seed-alpha-onchain-desk",
    name: "Onchain Degens & L2 Desk",
    ownerId: "vitailik-buterin",
    tier: "S_TIER",
    memberIds: ["vitailik-buterin", "brian-airmstrong", "airthur-hayes", "michael-sailor", "ainsem"],
    createdAgoMs: 4 * HOUR,
    messages: [
      {
        id: "seed-alpha-msg-13",
        senderId: "vitailik-buterin",
        body: "Drafting a quick 1,100-word note on blob fee markets and L2 rollup finality for $ETH before the candle closes.",
        createdAgoMs: 78 * MINUTE
      },
      {
        id: "seed-alpha-msg-14",
        senderId: "brian-airmstrong",
        body: "Listing queue is moving fast tonight. Status page might flash amber briefly while $COIN order flow spikes.",
        createdAgoMs: 49 * MINUTE
      },
      {
        id: "seed-alpha-msg-15",
        senderId: "airthur-hayes",
        body: "Perp funding spreads on $COIN and $STRAT are waking up. Watch the 8-hour funding boundary closely.",
        createdAgoMs: 25 * MINUTE
      },
      {
        id: "seed-alpha-msg-16",
        senderId: "michael-sailor",
        body: "Volatility is vitality. Issuing convertible conviction directly into $STRAT.",
        createdAgoMs: 9 * MINUTE
      }
    ]
  },
  {
    id: "seed-alpha-open-weights",
    name: "Open Weights & GPU Cartel",
    ownerId: "mark-zuckerborg",
    tier: "S_TIER",
    memberIds: ["mark-zuckerborg", "yainn-lecun", "jensen-huaing", "sim-cook", "lisai-su"],
    createdAgoMs: 4 * HOUR,
    messages: [
      {
        id: "seed-alpha-msg-17",
        senderId: "mark-zuckerborg",
        body: "Checkpoint upload is testing at 140B parameters. Let's see how $AIPPL unified memory handles open weights. $METAI",
        createdAgoMs: 72 * MINUTE
      },
      {
        id: "seed-alpha-msg-18",
        senderId: "sim-cook",
        body: "Our silicon efficiency per watt remains unmatched. We think customers are going to love our RAM tiers. $AIPPL",
        createdAgoMs: 44 * MINUTE
      },
      {
        id: "seed-alpha-msg-19",
        senderId: "yainn-lecun",
        body: "Autoregressive hype aside, open research checkpoints keep commoditizing closed APIs across $METAI.",
        createdAgoMs: 21 * MINUTE
      },
      {
        id: "seed-alpha-msg-20",
        senderId: "lisai-su",
        body: "Inference cluster orders are diversifying rapidly. Supply chain tape is busy across the board.",
        createdAgoMs: 6 * MINUTE
      }
    ]
  }
]

const MAJOR_LIQUID_TICKERS: ReadonlyArray<string> = ["NVDAI", "OPENAGI", "AITRP", "TSLAI", "METAI", "COIN"]
const AFFILIATED_HOLDING_NOTIONAL_CENTS = 2_000_000
const STARTER_HOLDING_NOTIONAL_CENTS = 500_000
const INITIAL_HISTORY_POINTS = 8

function deterministicHash(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** @throws {never} */
export function isRuntimeActor(actor: PackActor): boolean {
  return !/\btest\b/i.test(actor.id) && !actor.id.toLowerCase().startsWith("test-")
}

/** @throws {never} */
export function initialSpotQuoteReserveCents(priceCents: number): number {
  return Math.max(1, Math.round((INITIAL_SPOT_BASE_RESERVE / SPOT_BASE_SCALE) * priceCents))
}

/** @throws {never} */
export function buildNpcSpotHoldingRows(
  runtimeActors: ReadonlyArray<PackActor>,
  tradeableOrgs: ReadonlyArray<TradeableOrgSeed>,
  now: number
): ReadonlyArray<ReadonlyArray<unknown>> {
  const orgById = new Map<string, TradeableOrgSeed>()
  const orgByTicker = new Map<string, TradeableOrgSeed>()
  for (const item of tradeableOrgs) {
    orgById.set(item.org.id, item)
    orgByTicker.set(item.ticker, item)
  }
  const rows: Array<ReadonlyArray<unknown>> = []
  for (let actorIndex = 0; actorIndex < runtimeActors.length; actorIndex++) {
    const actor = runtimeActors[actorIndex]
    if (actor === undefined) continue
    const holdings = new Map<string, number>()
    for (const orgId of actor.affiliations) {
      const affiliated = orgById.get(orgId)
      if (affiliated !== undefined) {
        const units = Math.max(100, Math.ceil((AFFILIATED_HOLDING_NOTIONAL_CENTS * SPOT_BASE_SCALE) / affiliated.priceCents))
        holdings.set(affiliated.ticker, units)
      }
    }
    for (const ticker of MAJOR_LIQUID_TICKERS) {
      if (holdings.has(ticker)) continue
      const item = orgByTicker.get(ticker)
      if (item !== undefined) {
        const units = Math.max(100, Math.ceil((STARTER_HOLDING_NOTIONAL_CENTS * SPOT_BASE_SCALE) / item.priceCents))
        holdings.set(item.ticker, units)
      }
    }
    if (tradeableOrgs.length > 0) {
      for (const offset of [0, 7]) {
        const picked = tradeableOrgs[(actorIndex + offset) % tradeableOrgs.length]
        if (picked !== undefined && !holdings.has(picked.ticker)) {
          const units = Math.max(100, Math.ceil((STARTER_HOLDING_NOTIONAL_CENTS * SPOT_BASE_SCALE) / picked.priceCents))
          holdings.set(picked.ticker, units)
        }
      }
    }
    for (const [ticker, baseUnits] of holdings) {
      rows.push([actor.id, ticker, baseUnits, now])
    }
  }
  return rows
}

/** @throws {never} */
export function buildInitialPriceHistoryRows(
  markets: ReadonlyArray<InitialMarketSeed>,
  tradeableOrgs: ReadonlyArray<TradeableOrgSeed>,
  now: number
): ReadonlyArray<ReadonlyArray<unknown>> {
  const rows: Array<ReadonlyArray<unknown>> = []
  for (const market of markets) {
    const totalShares = market.yesShares + market.noShares
    const finalYesBps = totalShares > 0 ? Math.floor((market.noShares * 10_000) / totalShares) : 5000
    const spanMs = Math.max(7 * MINUTE, market.createdAgoMs)
    const seed = deterministicHash(market.id)
    const startYesBps = 5000 + ((seed % 401) - 200)
    for (let idx = 0; idx < INITIAL_HISTORY_POINTS; idx++) {
      const progress = idx / (INITIAL_HISTORY_POINTS - 1)
      const wave = idx === INITIAL_HISTORY_POINTS - 1
        ? 0
        : Math.round(Math.sin(progress * Math.PI * 2 + (seed % 7)) * 180)
      const yesBps = idx === INITIAL_HISTORY_POINTS - 1
        ? finalYesBps
        : Math.max(500, Math.min(9500, Math.round(startYesBps + (finalYesBps - startYesBps) * progress + wave)))
      const priceCents = Math.max(1, Math.min(99, Math.round(yesBps / 100)))
      const volumeCents = 1_500 + ((seed + idx * 733) % 6_500)
      const recordedAt = now - Math.round((1 - progress) * spanMs)
      rows.push([
        `seed-hist-pred-${market.id}-${idx}`,
        "prediction",
        market.id,
        priceCents,
        yesBps,
        null,
        volumeCents,
        recordedAt
      ])
    }
  }
  for (const item of tradeableOrgs) {
    const seed = deterministicHash(item.ticker)
    const startOffsetBps = ((seed % 501) - 250)
    for (let idx = 0; idx < INITIAL_HISTORY_POINTS; idx++) {
      const progress = idx / (INITIAL_HISTORY_POINTS - 1)
      const remaining = 1 - progress
      const waveBps = idx === INITIAL_HISTORY_POINTS - 1
        ? 0
        : Math.round(Math.sin(progress * Math.PI * 2.5 + (seed % 11)) * 95 * remaining)
      const driftBps = Math.round(startOffsetBps * remaining + waveBps)
      const indexPriceCents = idx === INITIAL_HISTORY_POINTS - 1
        ? item.priceCents
        : Math.max(1, Math.round((item.priceCents * (10_000 + driftBps)) / 10_000))
      const premBps = idx === INITIAL_HISTORY_POINTS - 1
        ? 0
        : (((seed >> (idx % 8)) % 25) - 12)
      const markPriceCents = idx === INITIAL_HISTORY_POINTS - 1
        ? item.priceCents
        : Math.max(1, Math.round((indexPriceCents * (10_000 + premBps)) / 10_000))
      const volumeCents = 5_000 + ((seed + idx * 1_997) % 45_000)
      const recordedAt = now - (INITIAL_HISTORY_POINTS - 1 - idx) * HOUR
      rows.push([
        `seed-hist-perp-${item.ticker}-${idx}`,
        "perp",
        item.ticker,
        indexPriceCents,
        null,
        markPriceCents,
        volumeCents,
        recordedAt
      ])
    }
  }
  return rows
}

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
export function buildInsertBatches(
  table: string,
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  conflictClause: string,
  chunkSize = 400
): ReadonlyArray<BatchQuery> {
  if (rows.length === 0) return []
  const batches: BatchQuery[] = []
  for (let start = 0; start < rows.length; start += chunkSize) {
    const batch = buildInsertBatch(table, columns, rows.slice(start, start + chunkSize), conflictClause)
    if (batch !== undefined) batches.push(batch)
  }
  return batches
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
