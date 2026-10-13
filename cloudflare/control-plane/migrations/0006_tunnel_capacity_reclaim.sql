ALTER TABLE installation_endpoints
  ADD COLUMN reclaim_requested_at INTEGER;

UPDATE installation_endpoints
   SET reclaim_requested_at = delete_requested_at
 WHERE status = 'deleting'
   AND delete_requested_at BETWEEN 1790848800000 AND 1790850600000
   AND EXISTS (
     SELECT 1 FROM installations i
      WHERE i.id = installation_endpoints.installation_id
        AND i.revoked_at IS NULL
   );

CREATE TABLE managed_endpoint_capacity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  scan_page INTEGER NOT NULL DEFAULT 1 CHECK (scan_page >= 1),
  tunnel_count INTEGER CHECK (tunnel_count IS NULL OR tunnel_count >= 0),
  dns_record_count INTEGER CHECK (dns_record_count IS NULL OR dns_record_count >= 0),
  reclaim_pending INTEGER NOT NULL DEFAULT 0 CHECK (reclaim_pending >= 0),
  checked_at INTEGER,
  capacity_rejected_at INTEGER,
  capacity_rejected_code TEXT CHECK (
    capacity_rejected_code IS NULL OR length(capacity_rejected_code) BETWEEN 1 AND 64
  ),
  updated_at INTEGER NOT NULL
);

INSERT INTO managed_endpoint_capacity (id, scan_page, reclaim_pending, updated_at)
VALUES (1, 1, 0, 0);
