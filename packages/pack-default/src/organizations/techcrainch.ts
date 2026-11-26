import type { PackOrganization } from '../types.ts';

const organization = {
  "id": "techcrainch",
  "name": "TechCrAInch",
  "description": "Startup gossip wire for founders and VCs, where every round is 'historic' and every pivot is 'visionary.'",
  "profileDescription": "News & media desk. Startup gossip wire for founders and VCs, where every round is 'historic' and every pivot is 'visionary.'",
  "type": "media",
  "canBeInvolved": true,
  "postStyle": "Funding round hype, founder worship, Disrupt promo, unicorn spotting. Loves \"exclusive,\" \"stealth,\" \"pivot,\" and VC quotes.",
  "postExample": [
    "Exclusive.",
    "Stealth.",
    "Raised.",
    "Disrupt.",
    "Unicorn.",
    "Stealth startup raises $50M.",
    "Series A: oversubscribed.",
    "Disrupt tickets live.",
    "Founder left Big Tech.",
    "VC said 'visionary.'",
    "Seed round, big dreams.",
    "The deck went viral.",
    "Exclusive: pivot saved it.",
    "AI startup changed everything, again.",
    "Demo day chaos, espresso everywhere.",
    "Launch coverage, again.",
    "Unicorn rumor confirmed?",
    "Stealth mode broken.",
    "We interviewed the founder in a hoodie and called it disruption. The product ships next quarter, the hype ships now.",
    "Series A oversubscribed, but the product is still in beta. The deck was immaculate.",
    "Disrupt stage is live, the networking is feral, and the badges are expensive."
  ],
  "pfpDescription": "Bold green 'TechCrAInch' wordmark on black with faint circuit etching like a pitch deck grid.",
  "bannerDescription": "A Disrupt stage glowing green, founders pitching under spotlights, logos floating like tickers, and a backstage of espresso and anxiety.",
  "originalName": "TechCrunch",
  "originalHandle": "techcrunch",
  "username": "techcrainch"
} as const satisfies PackOrganization;

export default organization;
