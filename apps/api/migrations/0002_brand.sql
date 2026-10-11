-- Brand look of the widget. NULL = widget default.
ALTER TABLE sites ADD COLUMN background TEXT;      -- '#rrggbb'
ALTER TABLE sites ADD COLUMN text_color TEXT;      -- '#rrggbb'
ALTER TABLE sites ADD COLUMN font TEXT;            -- one font family name
ALTER TABLE sites ADD COLUMN logo_url TEXT;
-- 1 once the owner edits the look by hand: crawls then stop overwriting it.
ALTER TABLE sites ADD COLUMN brand_locked INTEGER NOT NULL DEFAULT 0;
