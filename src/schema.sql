CREATE TABLE IF NOT EXISTS chunks (
    id SERIAL PRIMARY KEY,
    text TEXT NOT NULL,
    url TEXT NOT NULL,
    index INTEGER NOT NULL,
    UNIQUE(url, index)
);