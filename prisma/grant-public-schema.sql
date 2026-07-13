-- PostgreSQL 15+ revokes CREATE on the public schema from non-owner roles by
-- default. Managed Postgres providers (e.g. DigitalOcean App Platform's dev
-- database) connect the app as a non-owner user, so `prisma migrate deploy`
-- fails with "permission denied for schema public" unless this is granted
-- once per database. Safe to run repeatedly (idempotent).
GRANT ALL ON SCHEMA public TO CURRENT_USER;
