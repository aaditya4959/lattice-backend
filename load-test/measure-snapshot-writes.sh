#!/usr/bin/env bash
# Reports actual doc_snapshots write cadence for docs created by the most recent
# load-test run (title LIKE 'Load test doc%') — the client-side k6 script can't see
# this side; SnapshotSchedulerService writes are entirely server/Postgres-side.
set -euo pipefail

: "${PGHOST:=localhost}"
: "${PGPORT:=5432}"
: "${PGUSER:=lattice}"
: "${PGPASSWORD:=lattice}"
: "${PGDATABASE:=lattice}"
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE

psql -v ON_ERROR_STOP=1 <<'SQL'
SELECT
  d.title,
  count(s.*) AS snapshot_count,
  min(s.created_at) AS first_write,
  max(s.created_at) AS last_write,
  round(extract(epoch FROM (max(s.created_at) - min(s.created_at))) / NULLIF(count(s.*) - 1, 0), 2) AS avg_seconds_between_writes
FROM docs d
JOIN doc_snapshots s ON s.doc_id = d.id
WHERE d.title LIKE 'Load test doc%'
GROUP BY d.id, d.title
ORDER BY d.title;
SQL
