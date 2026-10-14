BEGIN IMMEDIATE;
CREATE TABLE route_configs (
    id TEXT PRIMARY KEY COLLATE NOCASE,
    body TEXT NOT NULL,
    position INTEGER NOT NULL
);
CREATE TABLE route_groups (
    id TEXT PRIMARY KEY COLLATE NOCASE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL
);
CREATE TABLE group_members (
    group_id TEXT NOT NULL REFERENCES route_groups(id) ON DELETE CASCADE,
    route_id TEXT NOT NULL REFERENCES route_configs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY(group_id, route_id)
);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE operations(id TEXT PRIMARY KEY, started_at TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE created_routes(route_key TEXT PRIMARY KEY, created_at TEXT NOT NULL);
PRAGMA user_version=1;
COMMIT;
