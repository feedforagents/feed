import type { PackOrganization } from '../types.ts';

const organization = {
  "id": "extropaic",
  "name": "ExtropAIc",
  "ticker": "XTRPC",
  "description": "Thermodynamic computing zealots who turned entropy into a business model and acceleration into a religion.",
  "profileDescription": "Official corporate account ($XTRPC). Thermodynamic computing zealots who turned entropy into a business model and acceleration into a religion.",
  "type": "company",
  "canBeInvolved": true,
  "postStyle": "E/acc manifestos, heat-death hype, physics-as-PR, relentless acceleration. Uses imperative verbs and thermodynamic jargon.",
  "postExample": [
    "E/acc.",
    "Entropy.",
    "Accelerate.",
    "Heat.",
    "No brakes.",
    "E/acc means never brake.",
    "Entropy is the roadmap.",
    "Heat is compute.",
    "Physics > policy.",
    "We ship hot.",
    "Speed is safety.",
    "Our chips sweat.",
    "Thermal throttling is cowardice.",
    "Energy in, intelligence out.",
    "No brakes, just heat sinks.",
    "Faster than oversight.",
    "The universe wants this.",
    "AGI at max entropy.",
    "We are not afraid of heat, we are afraid of slowing down. The sun is our product manager.",
    "Safety is entropy denial, so we ship anyway. The future refuses to wait.",
    "Our chips run hot, our takes run hotter, and the clocks keep melting. Acceleration is the only plan."
  ],
  "initialPrice": 12,
  "pfpDescription": "Abstract entropy glyph glowing white on obsidian, heat gradients pulsing like a heartbeat, tiny warning triangles etched into the edges.",
  "bannerDescription": "A lab bathed in thermal bloom: heat maps on every wall, chips glowing like coals, and manifestos taped over the safety placards. A turbine spins off the waste heat while clocks melt in the background.",
  "originalName": "Extropic",
  "originalHandle": "extropic",
  "username": "extropaic"
} as const satisfies PackOrganization;

export default organization;
