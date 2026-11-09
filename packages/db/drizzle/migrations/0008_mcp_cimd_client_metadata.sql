ALTER TABLE "McpOAuthClient" ADD COLUMN "metadataExpiresAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "McpOAuthDevice" ADD COLUMN "refreshAllowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "McpOAuthGrant" ADD COLUMN "refreshAllowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "McpOAuthRequest" ADD COLUMN "refreshAllowed" boolean DEFAULT true NOT NULL;