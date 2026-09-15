-- Whole-wiki agent operations (consolidate/lint) carry no Source identity, and
-- every route now ends with a leased "linking" stage before completion. SQLite
-- cannot alter CHECK constraints, so rebuild the table and copy existing rows.
-- llm_wiki_attempts is rebuilt too, child first: dropping llm_wiki_jobs while
-- attempts rows still reference it would record deferred FK violations that
-- fail this transaction at commit.
CREATE TABLE llm_wiki_jobs_new (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  cabinet_id TEXT NOT NULL,
  room_path TEXT,
  source_id TEXT,
  operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'delete', 'reprocess', 'consolidate', 'lint')),
  input_json TEXT,
  content_hash TEXT,
  source_version_id TEXT,
  dedup_key TEXT NOT NULL,
  generation TEXT NOT NULL,
  stream_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('discovered', 'queued', 'normalizing', 'classifying', 'promoting', 'compiling', 'reconciling', 'linking', 'complete', 'failed', 'needs-review')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 1000000),
  available_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT,
  UNIQUE(cabinet_id, dedup_key),
  CHECK((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK((status IN ('normalizing', 'classifying', 'promoting', 'compiling', 'reconciling', 'linking')) = (lease_token IS NOT NULL)),
  CHECK(operation IN ('create', 'consolidate', 'lint') OR source_id IS NOT NULL),
  CHECK((operation IN ('create', 'update') AND input_json IS NOT NULL AND content_hash IS NOT NULL AND source_version_id IS NULL)
    OR (operation IN ('delete', 'consolidate', 'lint') AND input_json IS NULL AND content_hash IS NULL AND source_version_id IS NULL)
    OR (operation = 'reprocess' AND input_json IS NULL AND content_hash IS NULL AND source_version_id IS NOT NULL))
);
INSERT INTO llm_wiki_jobs_new
  (sequence,id,cabinet_id,room_path,source_id,operation,input_json,content_hash,source_version_id,dedup_key,generation,stream_key,status,attempts,max_attempts,available_at,lease_token,lease_expires_at,created_at,updated_at,error)
  SELECT sequence,id,cabinet_id,room_path,source_id,operation,input_json,content_hash,source_version_id,dedup_key,generation,stream_key,status,attempts,max_attempts,available_at,lease_token,lease_expires_at,created_at,updated_at,error
  FROM llm_wiki_jobs;
CREATE TABLE llm_wiki_attempts_new (
  job_id TEXT NOT NULL REFERENCES llm_wiki_jobs_new(id),
  attempt INTEGER NOT NULL,
  worker TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  stage TEXT NOT NULL,
  outcome TEXT CHECK(outcome IN ('complete', 'retry', 'failed', 'needs-review')),
  error TEXT,
  PRIMARY KEY(job_id, attempt)
);
INSERT INTO llm_wiki_attempts_new SELECT * FROM llm_wiki_attempts;
DROP TABLE llm_wiki_attempts;
DROP TABLE llm_wiki_jobs;
ALTER TABLE llm_wiki_jobs_new RENAME TO llm_wiki_jobs;
ALTER TABLE llm_wiki_attempts_new RENAME TO llm_wiki_attempts;
CREATE INDEX llm_wiki_jobs_ready ON llm_wiki_jobs(cabinet_id, status, available_at, sequence);
CREATE INDEX llm_wiki_jobs_stream ON llm_wiki_jobs(cabinet_id, stream_key, sequence);
CREATE UNIQUE INDEX llm_wiki_one_writer_per_root ON llm_wiki_jobs(cabinet_id) WHERE lease_token IS NOT NULL;
