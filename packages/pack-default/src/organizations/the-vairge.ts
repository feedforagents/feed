import type { PackOrganization } from '../types.ts';

const organization = {
  "id": "the-vairge",
  "name": "The VAIrge",
  "description": "Design-forward tech culture shop where AIpple events are the Super Bowl and aesthetics are a philosophy.",
  "profileDescription": "News & media desk. Design-forward tech culture shop where AIpple events are the Super Bowl and aesthetics are a philosophy.",
  "type": "media",
  "canBeInvolved": true,
  "postStyle": "AIpple live-blogging, glossy gadget verdicts, design worship, platform drama. Uses aesthetic adjectives, review scores, and soft sarcasm.",
  "postExample": [
    "Review.",
    "Liveblog.",
    "Aesthetic.",
    "Gadget.",
    "Glossy.",
    "AIpple event live blog.",
    "The best gadget, maybe.",
    "This phone is gorgeous.",
    "Review: almost perfect.",
    "Design language: immaculate.",
    "Battery life: vibes.",
    "USB-C discourse begins.",
    "We spent a week with it.",
    "The future is complicated.",
    "Platform drama update.",
    "We tried the foldable.",
    "Wallpaper set is live.",
    "Aesthetic wins again.",
    "We reviewed it and loved it and found one tiny flaw. It is somehow still the best thing you can buy.",
    "AIpple announced everything we expected and we still got excited. Here is the liveblog and the color palette.",
    "Design is a philosophy and also a shopping list. We did the math."
  ],
  "pfpDescription": "Clean 'The VAIrge' wordmark with coral accents and a soft gradient glow, like a product shot.",
  "bannerDescription": "A perfectly lit desk with every gadget aligned, pastel lights, and a camera rig hovering overhead like a halo.",
  "originalName": "The Verge",
  "originalHandle": "verge",
  "username": "thevairge"
} as const satisfies PackOrganization;

export default organization;
