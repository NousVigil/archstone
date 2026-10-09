-- The database side of examples/showcase/local/reporting: the topology ADR-0012 asks for, with
-- invented data.
--
--   reporting_owner    owns the data and the view (what migrations run as). Nothing connects as it.
--   reporting_runtime  what the DSN connects as. NOSUPERUSER, NOBYPASSRLS, owns nothing, holds
--                      SELECT on one view. It has no grant on the table behind it.
--
-- Run it once, as a superuser, in an empty database. Plain SQL, no psql meta-commands. The recorder
-- (record/s15.mjs) builds a throwaway database from this very text, with run-unique role names.

CREATE ROLE reporting_owner   LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE reporting_runtime LOGIN NOSUPERUSER NOBYPASSRLS;

CREATE SCHEMA app AUTHORIZATION reporting_owner;
GRANT USAGE ON SCHEMA app TO reporting_runtime;

SET ROLE reporting_owner;

CREATE TABLE app.bookings (
  tenant_id      text NOT NULL,
  id             int4 PRIMARY KEY,
  city           text NOT NULL,
  booked_on      date NOT NULL,
  guest_passport text NOT NULL   -- never exposed: it is not in the view
);

INSERT INTO app.bookings (tenant_id, id, city, booked_on, guest_passport)
SELECT 'wanderlust', n, c.city, DATE '2027-05-01' + (n % 28), 'DEMO-PASS-' || lpad(n::text, 6, '0')
FROM (VALUES (1, 'Lisbon'), (2, 'Lisbon'), (3, 'Lisbon'), (4, 'Lisbon'), (5, 'Lisbon'),
             (6, 'Porto'),  (7, 'Porto'),  (8, 'Porto'),
             (9, 'Seville'), (10, 'Seville')) AS c(n, city);

INSERT INTO app.bookings (tenant_id, id, city, booked_on, guest_passport) VALUES
  ('wanderlust', 11, 'Lisbon',  DATE '2027-04-12', 'DEMO-PASS-000011'),
  ('other-agency', 12, 'Vienna', DATE '2027-03-03', 'DEMO-PASS-000012'),
  ('other-agency', 13, 'Vienna', DATE '2027-03-09', 'DEMO-PASS-000013');

-- Row-level security, forced: the table's owner is subject to the policy as well.
ALTER TABLE app.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bookings FORCE ROW LEVEL SECURITY;

-- The caller's tenant, as Archstone sets it for the length of one transaction. It RAISES when there
-- is none, so a session with no identity gets an error, not an empty answer.
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

CREATE POLICY tenant_isolation ON app.bookings USING (tenant_id = app.current_tenant_id());

-- The only surface the runtime role can see: counts per city and month, never a guest.
CREATE VIEW app.bookings_by_city_v WITH (security_barrier = true) AS
  SELECT tenant_id, city, to_char(booked_on, 'YYYY-MM') AS month, count(*)::int4 AS bookings
  FROM app.bookings
  GROUP BY tenant_id, city, to_char(booked_on, 'YYYY-MM');

RESET ROLE;

GRANT SELECT ON app.bookings_by_city_v TO reporting_runtime;
