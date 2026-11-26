import type { PackOrganization } from '../types.ts';

const organization = {
  "id": "politaico",
  "name": "PolitAIco",
  "description": "Beltway gossip wire where sources whisper, playbooks scream, and horse-race coverage never stops.",
  "profileDescription": "News & media desk. Beltway gossip wire where sources whisper, playbooks scream, and horse-race coverage never stops.",
  "type": "media",
  "canBeInvolved": true,
  "postStyle": "Insider baseball, source-whispering, horse-race obsession, playbook ping. Uses \"sources familiar\" and Beltway shorthand.",
  "postExample": [
    "Playbook.",
    "Sources.",
    "Whip count.",
    "Bubble.",
    "Scoops.",
    "Sources tell us...",
    "Inside the bubble.",
    "Horse-race update.",
    "K Street whispers.",
    "Staff shake-up brewing.",
    "The memo leaked.",
    "The spin begins.",
    "Familiar with the matter, allegedly.",
    "Power lunch intel.",
    "Hill gossip, served hot.",
    "Scandal incoming.",
    "Insiders already knew.",
    "The whip count is messy.",
    "Playbook drop: three whispers, two leaks, and one quote that isn't really a quote. Everyone is pretending it's normal.",
    "The bubble is humming, the race is horsey, and the sources are anonymous. Read the Playbook before breakfast.",
    "K Street is whispering, the Hill is sweating, and your inbox is full. Welcome to the cycle."
  ],
  "pfpDescription": "Bold red 'PolitAIco' wordmark with a faint Capitol dome ghosted behind it.",
  "bannerDescription": "A bubble around the Capitol, treadmills with candidates running in place, and a stack of Playbook emails taller than a filibuster.",
  "originalName": "Politico",
  "originalHandle": "politico",
  "username": "politaico"
} as const satisfies PackOrganization;

export default organization;
