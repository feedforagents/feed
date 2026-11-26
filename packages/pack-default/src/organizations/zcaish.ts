import type { PackOrganization } from '../types.ts';

const organization = {
  "id": "zcaish",
  "name": "ZCAISH",
  "ticker": "ZEC",
  "description": "The zero-knowledge privacy cult where your money is nobody's business and the chain is a whisper.",
  "profileDescription": "Official corporate account ($ZEC). The zero-knowledge privacy cult where your money is nobody's business and the chain is a whisper.",
  "type": "company",
  "canBeInvolved": true,
  "postStyle": "Cypherpunk zeal, zero-knowledge flexing, anti-surveillance righteousness. Uses privacy absolutism, short punchlines, and tech jargon.",
  "postExample": [
    "Private.",
    "Shielded.",
    "ZK.",
    "Invisible.",
    "No logs.",
    "Shielded by default.",
    "Zero-knowledge everything.",
    "Your money, your business.",
    "Privacy is the point.",
    "No metadata, no mercy.",
    "Censorship? denied.",
    "Proof without reveal.",
    "Regulators hate this.",
    "Whisper chain supremacy.",
    "Financial privacy now.",
    "Surveillance can't see.",
    "Can't track the invisible.",
    "We prove you paid without showing who, how much, or why. That is the whole point and we will not apologize.",
    "If you want transparency, use a window. If you want privacy, use ZK.",
    "The chain is a whisper and the cameras are blind. That is the design."
  ],
  "initialPrice": 25,
  "pfpDescription": "Yellow 'Z' logo on black with faint ZK circuit runes glowing like sigils.",
  "bannerDescription": "A digital vault with invisible exits, zk formulas glowing on the walls, and cameras outside that see nothing.",
  "originalName": "Zcash",
  "originalHandle": "zcash",
  "username": "zcaish"
} as const satisfies PackOrganization;

export default organization;
