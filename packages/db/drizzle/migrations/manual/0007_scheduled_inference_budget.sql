CREATE TABLE "ScheduledInferenceReservation" (
	"id" text PRIMARY KEY NOT NULL,
	"boundMicroUsd" bigint NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"costMicroUsd" bigint,
	"settledAt" timestamp with time zone,
	CONSTRAINT "scheduled_inference_positive_bound" CHECK ("ScheduledInferenceReservation"."boundMicroUsd" > 0),
	CONSTRAINT "scheduled_inference_settlement_pair" CHECK (("ScheduledInferenceReservation"."settledAt" IS NULL AND "ScheduledInferenceReservation"."costMicroUsd" IS NULL)
          OR ("ScheduledInferenceReservation"."settledAt" IS NOT NULL AND "ScheduledInferenceReservation"."costMicroUsd" IS NOT NULL AND "ScheduledInferenceReservation"."costMicroUsd" >= 0))
);
--> statement-breakpoint
CREATE INDEX "scheduled_inference_settled_at_idx" ON "ScheduledInferenceReservation" USING btree ("settledAt");--> statement-breakpoint
CREATE INDEX "scheduled_inference_bound_violation_idx" ON "ScheduledInferenceReservation" USING btree ("id") WHERE "ScheduledInferenceReservation"."costMicroUsd" > "ScheduledInferenceReservation"."boundMicroUsd";