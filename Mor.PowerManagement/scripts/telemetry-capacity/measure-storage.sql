-- MANUAL, READ ONLY. Run only on a separately verified rehearsal/test destination.
-- No extensions, ANALYZE/VACUUM, row scans, mutations, timers or production access.
BEGIN TRANSACTION READ ONLY;
SELECT current_database() AS database_name, clock_timestamp() AS captured_at_utc,
       pg_database_size(current_database()) AS database_bytes;
SELECT s.schemaname, s.relname,
       pg_table_size(s.relid) AS table_toast_bytes,
       pg_indexes_size(s.relid) AS index_bytes,
       pg_total_relation_size(s.relid) AS total_bytes,
       c.reltuples AS planner_estimated_rows,
       s.n_live_tup, s.n_dead_tup,
       s.n_tup_ins, s.n_tup_upd, s.n_tup_del,
       s.n_mod_since_analyze, s.n_ins_since_vacuum,
       s.last_vacuum, s.last_autovacuum, s.vacuum_count, s.autovacuum_count,
       s.last_analyze, s.last_autoanalyze,
       CASE WHEN c.reltuples > 0 THEN pg_total_relation_size(s.relid) / c.reltuples END
           AS estimated_total_bytes_per_live_row
FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
ORDER BY pg_total_relation_size(s.relid) DESC, s.schemaname, s.relname;
SELECT schemaname, relname, indexrelname, pg_relation_size(indexrelid) AS index_bytes,
       idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes ORDER BY pg_relation_size(indexrelid) DESC;
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_stat_statements';
-- pg_stat_statements (if independently available) supplies calls/rows/timing,
-- not actual network egress. Do not install it as part of this script.
COMMIT;
