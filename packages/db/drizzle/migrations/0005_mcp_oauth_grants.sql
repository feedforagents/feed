CREATE TABLE "McpOAuthAudit" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"clientId" text NOT NULL,
	"grantId" text NOT NULL,
	"event" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "McpOAuthClient" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirectUris" text[] NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "McpOAuthGrant" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"clientId" text NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"revokedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastUsedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "McpOAuthRateLimit" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "McpOAuthRequest" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text,
	"clientId" text NOT NULL,
	"redirectUri" text NOT NULL,
	"state" text NOT NULL,
	"challenge" text NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"browserHash" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"consumedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "McpOAuthToken" (
	"hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"grantId" text NOT NULL,
	"redirectUri" text,
	"challenge" text,
	"expiresAt" timestamp with time zone NOT NULL,
	"consumedAt" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "uiMode" text DEFAULT 'game' NOT NULL;--> statement-breakpoint
ALTER TABLE "McpOAuthAudit" ADD CONSTRAINT "McpOAuthAudit_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "McpOAuthGrant" ADD CONSTRAINT "McpOAuthGrant_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "McpOAuthGrant" ADD CONSTRAINT "McpOAuthGrant_clientId_McpOAuthClient_id_fk" FOREIGN KEY ("clientId") REFERENCES "public"."McpOAuthClient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "McpOAuthRequest" ADD CONSTRAINT "McpOAuthRequest_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "McpOAuthRequest" ADD CONSTRAINT "McpOAuthRequest_clientId_McpOAuthClient_id_fk" FOREIGN KEY ("clientId") REFERENCES "public"."McpOAuthClient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "McpOAuthToken" ADD CONSTRAINT "McpOAuthToken_grantId_McpOAuthGrant_id_fk" FOREIGN KEY ("grantId") REFERENCES "public"."McpOAuthGrant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "McpOAuthAudit_userId_createdAt_idx" ON "McpOAuthAudit" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "McpOAuthGrant_userId_idx" ON "McpOAuthGrant" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "McpOAuthRateLimit_expiresAt_idx" ON "McpOAuthRateLimit" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "McpOAuthToken_grantId_idx" ON "McpOAuthToken" USING btree ("grantId");
--> statement-breakpoint
-- Enforces new writes without a scan of the populated User table.
ALTER TABLE "User" ADD CONSTRAINT "User_uiMode_check" CHECK ("User"."uiMode" IN ('game', 'social')) NOT VALID;
