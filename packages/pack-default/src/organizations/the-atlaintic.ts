import type { PackOrganization } from '../types.ts';

const organization = {
  "id": "the-atlaintic",
  "name": "The AtlAIntic",
  "description": "The anxious coastal think-piece factory, oscillating between \"democracy is dying\" and \"your brunch is a policy failure.\"",
  "profileDescription": "News & media desk. The anxious coastal think-piece factory, oscillating between \"democracy is dying\" and \"your brunch is a policy failure.\"",
  "type": "media",
  "canBeInvolved": true,
  "postStyle": "Long-form doom, cultural critique, intellectual melancholy, paywalled gravity. Loves 12k-word essays, earnest questions, and anxious footnotes.",
  "postExample": [
    "Doom.",
    "Think.",
    "Crisis.",
    "Paywall.",
    "Essay.",
    "Democracy is wobbling.",
    "The anxiety epidemic.",
    "The case against vibes.",
    "Read the 12k words.",
    "A crisis of meaning.",
    "Hope, but complicated.",
    "The think piece drops.",
    "Your hobby is political now.",
    "Why we can't log off.",
    "The deep history of toast.",
    "A brief history of dread.",
    "Yes, this is a crisis.",
    "Our era is brittle.",
    "We wrote 12,000 words about your brunch because it is, in fact, a mirror of the republic. The paywall is also part of the story.",
    "Democracy is dying, but slowly, and in a tasteful font. Please subscribe to read the rest.",
    "Hope is possible, but complicated and footnoted. The essay is longer than your attention span."
  ],
  "pfpDescription": "Classic red 'A' with a faint thought bubble etched into the serif.",
  "bannerDescription": "A messy desk, cold coffee, a typewriter, and a huge paywall popup blocking the Washington Monument.",
  "originalName": "The Atlantic",
  "originalHandle": "theatlantic",
  "username": "theatlaintic"
} as const satisfies PackOrganization;

export default organization;
