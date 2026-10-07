-- The database side of examples/manifests/sql-reporting: the topology ADR-0012 asks for.
--
--   reporting_owner    owns the data and the view (the role migrations run as). Nothing connects
--                      as it at runtime.
--   reporting_runtime  what the DSN connects as. NOSUPERUSER, NOBYPASSRLS, owns nothing, holds
--                      SELECT on one view. It has no grant on the table behind it.
--
-- Run it once, as a superuser, in an empty database (see README.md). It is plain SQL — no psql
-- meta-commands — so any client can run it. Then give reporting_runtime a password:
--   ALTER ROLE reporting_runtime PASSWORD '…';

CREATE ROLE reporting_owner   LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE reporting_runtime LOGIN NOSUPERUSER NOBYPASSRLS;

CREATE SCHEMA app AUTHORIZATION reporting_owner;
GRANT USAGE ON SCHEMA app TO reporting_runtime;

SET ROLE reporting_owner;

CREATE TABLE app.positions (
  tenant_id     text         NOT NULL,
  id            int4         PRIMARY KEY,
  label         text         NOT NULL,
  qty           int4         NOT NULL,
  internal_cost numeric(12,2) NOT NULL   -- never exposed: it is not in the view
);

INSERT INTO app.positions (tenant_id, id, label, qty, internal_cost) VALUES
  ('acme',   1, 'ACME-BOND-2031',     120, 98.40),
  ('acme',   2, 'ACME-EQUITY-ETF',     45, 41.10),
  ('globex', 3, 'GLOBEX-TREASURY-5Y', 300, 99.95),
  ('globex', 4, 'GLOBEX-CREDIT-FUND',  80, 87.25),
  ('globex', 5, 'GLOBEX-REIT',         12, 55.00);

-- Row-level security, forced: the table's owner is subject to the policy as well.
ALTER TABLE app.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.positions FORCE ROW LEVEL SECURITY;

-- The caller's tenant, as Archstone sets it for the length of one transaction. It RAISES when
-- there is none, so a session with no identity gets an error, not an empty answer. Postgres reads
-- a transaction-local setting back as '' (not NULL) once the transaction has ended, so both spell
-- "no identity".
CREATE FUNCTION app.current_tenant_id() RETURNS text LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  tenant text := current_setting('app.tenant_id', true);
BEGIN
  IF tenant IS NULL OR tenant = '' THEN
    RAISE EXCEPTION 'app.tenant_id is not set: no tenant identity for this session' USING ERRCODE = '28000';
  END IF;
  RETURN tenant;
END
$fn$;

CREATE POLICY tenant_isolation ON app.positions USING (tenant_id = app.current_tenant_id());

-- The only surface the runtime role can see. Owned by reporting_owner, so it reads the table as
-- that role — which the FORCEd policy still constrains.
CREATE VIEW app.positions_v WITH (security_barrier = true) AS
  SELECT tenant_id, id, label, qty FROM app.positions;

RESET ROLE;

GRANT SELECT ON app.positions_v TO reporting_runtime;
