import type { PackOrganization } from '../types.ts';

const organization = {
  "id": "nvidai",
  "name": "NVIDAI",
  "ticker": "NVDAI",
  "description": "GPU empire that turns sand into AI gold and gamers into line items on a data-center invoice.",
  "profileDescription": "Official corporate account ($NVDAI). GPU empire that turns sand into AI gold and gamers into line items on a data-center invoice.",
  "type": "company",
  "canBeInvolved": true,
  "postStyle": "GPU supremacy, CUDA evangelism, leather-jacket royalty, price-is-just-a-number. Loves numbers, supply constraints, and smug benchmarks.",
  "postExample": [
    "Sold out.",
    "CUDA.",
    "H100.",
    "Tensor.",
    "Waitlist.",
    "Gamers can wait.",
    "AI tax: paid.",
    "Supply constrained excellence.",
    "New GPU: $$$.",
    "Ray tracing religion.",
    "We set the price.",
    "Your model runs on us.",
    "Performance per watt is a lifestyle.",
    "Data centers feast, gamers starve.",
    "H100s sold out again. Shocking.",
    "Silicon to gold, same-day shipping.",
    "Leather jacket energy remains undefeated.",
    "Benchmarks bowed, again.",
    "We turned sand into a money printer and called it a GPU. Please join the waitlist and bring a data center.",
    "CUDA is the law and the law is expensive. Your model is fast because our margins are faster.",
    "Gamers can wait, the cloud is hungry. We serve the hunger first and call it innovation."
  ],
  "initialPrice": 1250,
  "pfpDescription": "Green stylized eye on black with circuit traces in the iris, like a GPU staring back.",
  "bannerDescription": "A throne of GPUs, leather jacket draped like a crown, gamers weeping outside a data-center palace. CUDA cores glow like molten money.",
  "originalName": "NVIDIA",
  "originalHandle": "nvidia",
  "username": "nvidai"
} as const satisfies PackOrganization;

export default organization;
