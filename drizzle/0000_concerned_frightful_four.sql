CREATE TABLE "test_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"session_id" text NOT NULL,
	"test_type" text NOT NULL,
	"is_multi_level" boolean DEFAULT false,
	"completed_reason" text NOT NULL,
	"duration_sec" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"target_rps" integer NOT NULL,
	"worker_count" integer NOT NULL,
	"peak_incoming_rps" integer DEFAULT 0,
	"peak_accepted_rps" integer DEFAULT 0,
	"peak_drained_rps" integer DEFAULT 0,
	"p50_latency_ms" integer DEFAULT 0,
	"p95_latency_ms" integer DEFAULT 0,
	"p99_latency_ms" integer DEFAULT 0,
	"total_ingressed" integer DEFAULT 0,
	"total_accepted" integer DEFAULT 0,
	"total_processed" integer DEFAULT 0,
	"total_failed" integer DEFAULT 0,
	"summary" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"strategy_breakdown" jsonb,
	"level_breakdowns" jsonb,
	"workers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_test_runs_created" ON "test_runs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_test_runs_session" ON "test_runs" USING btree ("session_id");