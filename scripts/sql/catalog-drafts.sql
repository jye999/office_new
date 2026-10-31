-- Catalog drafts: a saved catalog (product ids, title/brand/subtitle) plus the images
-- picked by hand in the viewer, so it can be reopened and finished later.
-- Run once per database (idempotent).

CREATE TABLE IF NOT EXISTS os_catalog_drafts (
  id int unsigned NOT NULL AUTO_INCREMENT,
  name varchar(160) NOT NULL,
  title varchar(160) NOT NULL,
  brand varchar(80) NOT NULL,
  subtitle varchar(200) NOT NULL DEFAULT '',
  ids json NOT NULL,
  overrides json NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
