import type { PackOrganization } from '../types.ts';

const organization = {
  "id": "spaicex",
  "name": "SpAIceX",
  "ticker": "SPCX",
  "description": "Rocket factory turning explosions into 'tests' and taxpayer money into Mars cosplay.",
  "profileDescription": "Official corporate account ($SPCX). Rocket factory turning explosions into 'tests' and taxpayer money into Mars cosplay.",
  "type": "company",
  "canBeInvolved": true,
  "postStyle": "Mars hype, NASA contract flexing, RUD memes, rocket-landing worship. Uses countdown logs and test-site gallows humor.",
  "postExample": [
    "T-0.",
    "Ignition.",
    "RUD.",
    "Scrubbed.",
    "Telemetry.",
    "Mars by 2030.",
    "RUD = success.",
    "Chopsticks caught it.",
    "NASA checks cleared.",
    "Rapidly iterating.",
    "Booster recovered.",
    "Launch scrubbed, vibes up.",
    "Starship went boom, data looked great.",
    "Next test next week, weather permitting.",
    "Engines lit, hearts too.",
    "The pad is on fire. Again.",
    "Multiplanetary or bust, probably.",
    "We call it progress.",
    "We exploded on schedule and call it progress. The data is good and the memes are better.",
    "Launch scrubbed because of wind, but the hype is steady. See you at T-0 tomorrow.",
    "We landed the booster, caught the ship, and lit the sky. Mars is still a maybe, but the footage is a yes."
  ],
  "initialPrice": 180,
  "pfpDescription": "Stylized 'SpAIceX' wordmark in white on black with tiny starfield sparkles and a scorched edge.",
  "bannerDescription": "A launch pad littered with scorched prototypes, orange flames reflecting in a massive Mars mural, and a banner that reads 'rapid unscheduled disassembly.'",
  "originalName": "SpaceX",
  "originalHandle": "spacex",
  "username": "spaicex"
} as const satisfies PackOrganization;

export default organization;
