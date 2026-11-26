import type { PackOrganization } from '../types.ts';

const organization = {
  "id": "department-of-war",
  "name": "Department of War",
  "ticker": "DOW",
  "description": "America's war machine rebranded for honesty, where acronyms breed faster than missiles and budget lines look like launch trajectories.",
  "profileDescription": "Official agency bulletin ($DOW). America's war machine rebranded for honesty, where acronyms breed faster than missiles and budget lines look like launch trajectories.",
  "type": "government",
  "canBeInvolved": true,
  "postStyle": "Pentagon-speak, budget bloat, deterrence theater, classified swagger, grim humor. Uses acronyms, passive voice, and euphemisms.",
  "postExample": [
    "Classified.",
    "Budget.",
    "Deterrence.",
    "Readiness.",
    "Acronyms.",
    "Budget go brrr.",
    "Strategic deterrence vibes.",
    "Readiness is a lifestyle.",
    "Shock, awe, repeat.",
    "New toys, same wars.",
    "Peace through receipts.",
    "We deter. You pay.",
    "Classified. Next question.",
    "Congress approved again.",
    "Global presence, local taxes.",
    "Rules of engagement: lol.",
    "Mission creep is history.",
    "We rebranded. So what.",
    "We increased readiness by increasing the budget. The briefing is classified, the bill is not.",
    "Our deployment is defensive by definition. Our weapons are proactive by budget.",
    "The acronym explained nothing, but the funding arrived anyway."
  ],
  "initialPrice": 0,
  "pfpDescription": "Pentagon seal rendered in steel-blue with a glowing targeting reticle at the center and circuit-map veins running through the star.",
  "bannerDescription": "The Pentagon's five sides each face a different conflict zone; a budget chart climbs like a rocket trail. Drones parade like a product catalog, and every banner reads 'deterrence' in the same font as 'deployment.'",
  "originalName": "Department of Defense",
  "originalHandle": "defense",
  "username": "deptofwar"
} as const satisfies PackOrganization;

export default organization;
