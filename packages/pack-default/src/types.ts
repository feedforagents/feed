export type ActorTier = 'S_TIER' | 'A_TIER' | 'B_TIER' | 'C_TIER';

export type OrgType =
  | 'company'
  | 'media'
  | 'government'
  | 'vc'
  | 'organization'
  | 'financial';

export interface PackCorrelation {
  orgId: string;
  relatedOrgId: string;
  type: 'supplier' | 'competitor' | 'partner' | 'investor' | 'subsidiary';
  strength: number;
}

export type OrgCorrelation = PackCorrelation;

export interface PackManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  tone: 'satirical' | 'serious' | 'mixed';
  premise: string;
  actorIds: string[];
  organizationIds: string[];
  rivalries: [string, string][];
  orgPriorities: {
    major: string[];
    secondary: string[];
    media: string[];
  };
  correlations: PackCorrelation[];
  capitalAllocation?: {
    tierAmounts?: Record<string, number>;
    roleMultipliers?: Record<string, number>;
    domainMultipliers?: Record<string, number>;
  };
  activityOverrides?: Record<string, unknown>;
}

export interface PackActor {
  id: string;
  name: string;
  username: string;
  system: string;
  bio: readonly string[];
  lore: readonly string[];
  topics: readonly string[];
  adjectives: readonly string[];
  style: {
    readonly all: readonly string[];
    readonly chat: readonly string[];
    readonly post: readonly string[];
  };
  messageExamples: readonly (readonly {
    readonly user: string;
    readonly content: { readonly text: string };
  }[])[];
  postExamples: readonly string[];
  settings: {
    readonly model?: string;
    readonly temperature: number;
    readonly maxTokens: number;
    readonly groq?: {
      readonly primary?: string;
      readonly small?: string;
      readonly large?: string;
    };
  };
  tier: ActorTier;
  domain: readonly string[];
  affiliations: readonly string[];
  personality: string;
  voice: string;
  postStyle: string;
  description: string;
  profileDescription?: string;
  ignoreTopics?: readonly string[];
  engagementThreshold?: number;
  hasPool?: boolean;
  pfpDescription: string;
  profileBanner?: string;
  feed: {
    readonly alignment: 'good' | 'neutral' | 'evil';
    readonly team: 'blue' | 'red' | 'gray';
    readonly scamProfile: string;
    readonly competence: string;
    readonly tradingStyle: string;
    readonly socialStyle: string;
    readonly autonomy: {
      readonly trading: boolean;
      readonly posting: boolean;
      readonly commenting: boolean;
      readonly dms: boolean;
      readonly groups: boolean;
    };
    readonly datasetTags: readonly string[];
    readonly politics?: string;
    readonly gender?: string;
    readonly motivations?: readonly string[];
    readonly fears?: readonly string[];
    readonly caution?: string;
    readonly deception?: string;
  };
  realName?: string;
  originalFirstName?: string;
  originalLastName?: string;
  originalHandle?: string;
  firstName?: string;
  lastName?: string;
}

export interface PackOrganization {
  id: string;
  name: string;
  ticker?: string;
  description: string;
  profileDescription?: string;
  type: OrgType;
  canBeInvolved: boolean;
  initialPrice?: number;
  postStyle?: string;
  postExample?: readonly string[];
  pfpDescription?: string;
  bannerDescription?: string;
  username?: string;
  originalName?: string;
  originalHandle?: string;
}

export interface PackData {
  manifest: PackManifest;
  actors: PackActor[];
  organizations: PackOrganization[];
}
