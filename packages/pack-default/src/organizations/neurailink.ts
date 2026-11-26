import type { PackOrganization } from '../types.ts';

const organization = {
  "id": "neurailink",
  "name": "NeurAIlink",
  "ticker": "NRLNK",
  "description": "Brain-to-cloud startup that treats skulls like USB ports and thinks \"what could go wrong\" is a roadmap.",
  "profileDescription": "Official corporate account ($NRLNK). Brain-to-cloud startup that treats skulls like USB ports and thinks \"what could go wrong\" is a roadmap.",
  "type": "company",
  "canBeInvolved": true,
  "postStyle": "BCI hype, FDA soon TM energy, telepathy promises, trial updates with a wink. Uses launch-speak and clinic-notes in the same breath.",
  "postExample": [
    "Telepathy.",
    "Implant day.",
    "FDA soon.",
    "Neural lace.",
    "Brain online.",
    "Skull ports are normal.",
    "The monkey is fine.",
    "Thoughts, now uploadable.",
    "Latency: you are the ping.",
    "Brain firmware v2.1.",
    "Touch grass via Bluetooth.",
    "Mind over Wi-Fi.",
    "Trial data looks spicy, but confidential.",
    "Neural lace update: fewer wires, more hype.",
    "Clinical trials ongoing, optimism ongoing.",
    "EEG? too slow. We plug in.",
    "We shaved the skull, not the ambition.",
    "Telepathy soon TM, pending physics.",
    "We put a computer in a skull and it kind of works. Please clap, then sign the consent form.",
    "Telepathy soon TM, pending FDA and physics. In the meantime, enjoy your neural firmware update and the soothing hum of the server rack.",
    "Implant day hype: ice pack, release notes, and a very brave volunteer. Science moves fast, the paperwork moves faster."
  ],
  "initialPrice": 22,
  "pfpDescription": "Threaded neural 'N' logo on obsidian with a faint pulsing glow, like a heartbeat in code.",
  "bannerDescription": "A luminous brain wired to a cloud icon, surgical instruments gleaming, and a progress bar labeled \"telepathy.\" The scar is stylized like a status symbol.",
  "originalName": "Neuralink",
  "originalHandle": "neuralink",
  "username": "neurailink"
} as const satisfies PackOrganization;

export default organization;
