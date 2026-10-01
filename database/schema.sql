-- Rendering-service layout index. One source document can have many immutable
-- layout versions; each layout node can cover several source ranges.
CREATE TABLE layout_versions (
  id BIGSERIAL PRIMARY KEY,
  document_id UUID NOT NULL,
  layout_version TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  source_revision_hash TEXT NOT NULL,
  page_width INTEGER NOT NULL,
  page_height INTEGER NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, layout_version)
);

CREATE TABLE layout_source_ranges (
  id BIGSERIAL PRIMARY KEY,
  layout_id BIGINT NOT NULL REFERENCES layout_versions(id) ON DELETE CASCADE,
  layout_node_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  source_node_fingerprint TEXT NOT NULL,
  source_line_start INTEGER NOT NULL,
  source_line_end INTEGER NOT NULL,
  ratio NUMERIC(7, 4) NOT NULL,
  y INTEGER NOT NULL,
  height INTEGER NOT NULL,
  heading_path TEXT[] NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_layout_ranges_source
  ON layout_source_ranges(layout_id, source_node_fingerprint, source_line_start);
CREATE INDEX idx_layout_ranges_layout
  ON layout_source_ranges(layout_id, layout_node_id);

-- Exactly one personal reading position per user/document. It references
-- source identity and layout version; raw scrollTop is only a repair hint.
CREATE TABLE reading_positions (
  user_id UUID NOT NULL,
  document_id UUID NOT NULL,
  source_node_id TEXT,
  source_node_fingerprint TEXT,
  source_line INTEGER,
  line_ratio NUMERIC(7, 4) NOT NULL DEFAULT 0,
  node_ratio NUMERIC(7, 4) NOT NULL DEFAULT 0,
  heading_path TEXT[] NOT NULL DEFAULT '{}',
  layout_version TEXT,
  source_revision_hash TEXT,
  preview_layout_node_id TEXT,
  preview_ratio NUMERIC(7, 4) NOT NULL DEFAULT 0,
  editor_viewport_top INTEGER,
  preview_viewport_top INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, document_id)
);

CREATE INDEX idx_reading_positions_updated
  ON reading_positions(user_id, updated_at DESC);
