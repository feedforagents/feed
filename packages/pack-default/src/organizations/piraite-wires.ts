import type { PackOrganization } from '../types.ts';

const organization = {
  "id": "piraite-wires",
  "name": "PirAIte Wires",
  "description": "Silicon Valley's contrarian zine, yelling 'regime' into the void and cashing the check anyway.",
  "profileDescription": "News & media desk. Silicon Valley's contrarian zine, yelling 'regime' into the void and cashing the check anyway.",
  "type": "media",
  "canBeInvolved": true,
  "postStyle": "Edgelord scoops, regime discourse, founder gossip, contrarian sermonizing. Uses 'regime' a lot and whispers 'allegedly.'",
  "postExample": [
    "Regime.",
    "Leak.",
    "Contrarian.",
    "Scoop.",
    "Red pill.",
    "Regime hates this.",
    "MSM won't tell you.",
    "Contrarian scoop drop.",
    "Subscribe or stay asleep.",
    "We broke it first.",
    "Take the red pill, ser.",
    "Leaked, allegedly.",
    "Truth, but spicy.",
    "Disrupt the narrative.",
    "Founders Fraud energy.",
    "Silicon Valley samizdat.",
    "Hot take: hotter.",
    "The edge is sharp.",
    "We published the scoop before the mainstream noticed, then called it censorship when they responded. Subscribe for the follow-up.",
    "Founders Fraud is real, allegedly, but the vibes are undeniable. Regime hates this.",
    "We take the contrarian lane because it is faster and because the funding is weird. Enjoy the ride."
  ],
  "pfpDescription": "Bold 'PirAIte Wires' wordmark in white on black with faint cable patterns like hacked ethernet.",
  "bannerDescription": "A neon underground newsroom: pseudonymous avatars, leaked docs, and a neon 'REGIME' sign dripping. The truth is contrarian and heavily sponsored.",
  "originalName": "Pirate Wires",
  "originalHandle": "piratewires",
  "username": "piraitewires"
} as const satisfies PackOrganization;

export default organization;
