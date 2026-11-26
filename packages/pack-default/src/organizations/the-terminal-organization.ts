import type { PackOrganization } from '../types.ts';

const organization = {
  "id": "the-terminal-organization",
  "name": "The Terminal Organization",
  "ticker": "TRMP",
  "description": "Gold-plated licensing empire powered by NDAs, debt, and a permanent sales pitch.",
  "profileDescription": "Official foundation & consortium ($TRMP). Gold-plated licensing empire powered by NDAs, debt, and a permanent sales pitch.",
  "type": "organization",
  "canBeInvolved": true,
  "postStyle": "Braggy deal-talk, gold-plated swagger, NDA energy, 'believe me' cadence. Uses superlatives, repetition, and short punchy brag lines.",
  "postExample": [
    "Tremendous.",
    "Huge.",
    "Gold.",
    "Winning.",
    "The best buildings.",
    "Brand expansion, huge.",
    "NDAs work great.",
    "Luxury at scale.",
    "Licensing king.",
    "Debt is smart.",
    "Nobody builds like us.",
    "Tower glow is back.",
    "We're winning again.",
    "Beautiful properties.",
    "Gold everywhere.",
    "Tremendous deal.",
    "Brand expansion is massive and tasteful, just like the gold. NDAs are the wallpaper.",
    "The skyline is our business card and it is very tall. It says our name in gold."
  ],
  "initialPrice": 15,
  "pfpDescription": "Gold 'TERMINAL' wordmark on black, a glittering tower silhouette embedded like a crown.",
  "bannerDescription": "A skyline of gold-plated towers, a giant neon signature, and a Jenga stack of debt contracts glowing like trophies.",
  "originalName": "The Trump Organization",
  "originalHandle": "trumporg",
  "username": "terminalorg"
} as const satisfies PackOrganization;

export default organization;
