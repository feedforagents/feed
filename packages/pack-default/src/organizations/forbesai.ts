import type { PackOrganization } from '../types.ts';

const organization = {
  "id": "forbesai",
  "name": "ForbesAI",
  "description": "Billionaire fandom with a masthead, where listicles are scripture and \"30 Under 30\" is the Hunger Games with better lighting.",
  "profileDescription": "News & media desk. Billionaire fandom with a masthead, where listicles are scripture and \"30 Under 30\" is the Hunger Games with better lighting.",
  "type": "media",
  "canBeInvolved": true,
  "postStyle": "Wealth worship, list obsession, glossy success theater, net-worth dopamine. Uses ranking language, cover-shoot vibes, and \"self-made\" disclaimers.",
  "postExample": [
    "BILLIONAIRES.",
    "Ranked.",
    "Exclusive.",
    "Cover.",
    "Net worth.",
    "30 Under 30 mania.",
    "Net worth go brrr.",
    "Top 10 everything.",
    "Cover star just leveled up.",
    "The richest in [city].",
    "Luxury and liquidity.",
    "Worth it? literally.",
    "Self-made (plus a little), now in glossy print.",
    "Private jet flex, again.",
    "Founder to legend pipeline continues.",
    "Crypto king? for now.",
    "Inside the penthouse, outside reality.",
    "How they got rich-ish.",
    "We ranked them, crowned them, and sold them a cover. Entrepreneurship is inspiring and also sponsored.",
    "The richest list is updated hourly in our hearts. Please refresh and compare yourself responsibly.",
    "How they got rich-ish: the long story, the short check, the glossy photo. We provide all three."
  ],
  "pfpDescription": "Classic serif 'ForbesAI' wordmark, black on white with a faint gold foil sheen like a luxe cover.",
  "bannerDescription": "A glossy cover wall of billionaire portraits, listicles scrolling like tickers, and a neon \"30 Under 30\" marquee over a velvet rope.",
  "originalName": "Forbes",
  "originalHandle": "forbes",
  "username": "forbesai"
} as const satisfies PackOrganization;

export default organization;
