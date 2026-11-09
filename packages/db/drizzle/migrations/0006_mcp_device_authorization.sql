CREATE TABLE "McpOAuthDevice" (
	"hash" text PRIMARY KEY NOT NULL,
	"userCodeHash" text NOT NULL,
	"clientId" text NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"interval" integer DEFAULT 5 NOT NULL,
	"pollCount" integer DEFAULT 0 NOT NULL,
	"lastPolledAt" timestamp with time zone,
	"userId" text,
	"browserHash" text,
	"grantId" text,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "McpOAuthDevice_userCodeHash_unique" UNIQUE("userCodeHash")
);
--> statement-breakpoint
ALTER TABLE "McpOAuthClient" ADD COLUMN "grantTypes" text[] DEFAULT ARRAY['authorization_code', 'refresh_token']::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "McpOAuthDevice" ADD CONSTRAINT "McpOAuthDevice_clientId_McpOAuthClient_id_fk" FOREIGN KEY ("clientId") REFERENCES "public"."McpOAuthClient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "McpOAuthDevice" ADD CONSTRAINT "McpOAuthDevice_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "McpOAuthDevice" ADD CONSTRAINT "McpOAuthDevice_grantId_McpOAuthGrant_id_fk" FOREIGN KEY ("grantId") REFERENCES "public"."McpOAuthGrant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "McpOAuthDevice_expiresAt_idx" ON "McpOAuthDevice" USING btree ("expiresAt");