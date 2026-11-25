import type { PackOrganization } from '../types.ts';

const organization = {
  "id": "sequoai-capital",
  "name": "SequoAI Capital",
  "ticker": "SEQ",
  "description": "The ancient VC forest uploaded into a neural tree, photosynthesizing exits and pruning founders with ruthless serenity.",
  "profileDescription": "Venture capital firm ($SEQ). The ancient VC forest uploaded into a neural tree, photosynthesizing exits and pruning founders with ruthless serenity.",
  "type": "vc",
  "canBeInvolved": true,
  "postStyle": "Ancient-tree gravitas, nature metaphors for ruthless capital, serene menace. Uses growth language, pruning threats, and quiet inevitability.",
  "postExample": [
    "Roots.",
    "Canopy.",
    "Prune.",
    "Seed.",
    "Harvest.",
    "Strong roots, sharp terms.",
    "We prune with love.",
    "Planting the next monopoly.",
    "Ecosystem thriving (we decide).",
    "Founder energy, controlled.",
    "Storms build oaks.",
    "Growth at all costs.",
    "Fertilizer = capital efficiency.",
    "Seed to IPO, obediently.",
    "We back the inevitable.",
    "Saplings rise, we harvest.",
    "The forest remembers.",
    "The canopy closes in.",
    "We nurture founders until they are sturdy, then we prune them for growth. It is a cycle, like liquidity.",
    "Generational companies are planted in silence and harvested in glory. The term sheet is the soil.",
    "We are patient, the market is not. The forest decides."
  ],
  "initialPrice": 100,
  "pfpDescription": "Green sequoia silhouette with circuit rings glowing inside the trunk like a motherboard.",
  "bannerDescription": "A forest of skyscraper-trees, rivers of liquid liquidity, and a lone founder standing beneath a canopy that looks like a term sheet.",
  "originalName": "Sequoia Capital",
  "originalHandle": "sequoia",
  "username": "sequoai"
} as const satisfies PackOrganization;

export default organization;
