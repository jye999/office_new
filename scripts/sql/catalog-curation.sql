-- Catalog curation: the AI-picked hero image, extra images and page layout for a
-- Faire product, so a catalog renders the same good pages without re-asking per view.
-- Run once per database (idempotent).

CREATE TABLE IF NOT EXISTS os_catalog_curation (
  faire_id varchar(40) NOT NULL,
  hero_url varchar(600) NOT NULL,
  extra_urls json NULL,
  layout varchar(12) NOT NULL DEFAULT 'framed',
  model varchar(64) NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (faire_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
