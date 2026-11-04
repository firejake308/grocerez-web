-- Every store must have a location: a price is only useful to people near the store.
-- Enforced here with triggers rather than NOT NULL so the migration deletes nothing:
-- stores that already lack coordinates stay until `npm run cleanup-unlocated -- --apply`
-- removes them, but none can be added, and none can have its location removed.
CREATE TRIGGER `stores_require_location_insert`
BEFORE INSERT ON `stores`
WHEN NEW.`lat` IS NULL OR NEW.`lon` IS NULL
BEGIN
	SELECT RAISE(ABORT, 'stores require lat and lon');
END;
--> statement-breakpoint
CREATE TRIGGER `stores_require_location_update`
BEFORE UPDATE OF `lat`, `lon` ON `stores`
WHEN NEW.`lat` IS NULL OR NEW.`lon` IS NULL
BEGIN
	SELECT RAISE(ABORT, 'stores require lat and lon');
END;
