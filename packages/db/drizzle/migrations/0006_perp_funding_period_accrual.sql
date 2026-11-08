CREATE TABLE "PerpPositionFundingAccrual" (
	"positionId" text NOT NULL,
	"periodStart" timestamp NOT NULL,
	CONSTRAINT "PerpPositionFundingAccrual_positionId_periodStart_pk" PRIMARY KEY("positionId","periodStart")
);
--> statement-breakpoint
ALTER TABLE "PerpPositionFundingAccrual" ADD CONSTRAINT "PerpPositionFundingAccrual_positionId_PerpPosition_id_fk" FOREIGN KEY ("positionId") REFERENCES "public"."PerpPosition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PerpPosition" DROP COLUMN "lastFundingPeriodStart";