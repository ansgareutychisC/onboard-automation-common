-- 0001_init.sql
--
-- The bridge worker itself does NOT need any tables — all bridge state
-- (connections, pending commands) is held in-memory by the BridgeHub DO.
--
-- Services that use this worker should add their own migrations, e.g.:
--   0002_service_accounts.sql
--   0003_service_jobs.sql
--
-- The following is an OPTIONAL audit-log table that any service can use
-- to record pipeline events. Mirrors the `event_logs` table from the
-- legacy supabase-automation project.

CREATE TABLE IF NOT EXISTS event_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account     TEXT,           -- service-specific account identifier (email, user_id, etc.)
    event_type  TEXT NOT NULL,  -- e.g. "signup_started", "signup_completed", "verify_email_received"
    severity    TEXT NOT NULL DEFAULT 'info',  -- info | warn | error
    message     TEXT NOT NULL,
    details     TEXT,           -- JSON blob with full context (stack, jobId, step arrays, etc.)
    trace_id    TEXT,           -- optional, correlates with extension command traceId
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_event_logs_account     ON event_logs(account);
CREATE INDEX IF NOT EXISTS idx_event_logs_created_at  ON event_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_logs_severity    ON event_logs(severity);
CREATE INDEX IF NOT EXISTS idx_event_logs_trace_id    ON event_logs(trace_id);
