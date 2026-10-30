-- Vendor users: a login (os_users + role 'vendor') linked to exactly one vendor (os_vendors).
-- A vendor user can only reach /vendor/* and manage products whose SKU is assigned to their vendor (os_sku_vendors).
-- Run once per database (idempotent).

CREATE TABLE IF NOT EXISTS os_vendor_users (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  user_id int unsigned NOT NULL,
  vendor_id bigint unsigned NOT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_vendor_user_user (user_id),
  KEY idx_vendor_user_vendor (vendor_id),
  CONSTRAINT fk_vendor_user_user FOREIGN KEY (user_id) REFERENCES os_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_vendor_user_vendor FOREIGN KEY (vendor_id) REFERENCES os_vendors (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO os_roles (name, created_at, updated_at)
SELECT 'vendor', NOW(), NOW() FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM os_roles WHERE name = 'vendor');
