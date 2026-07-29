-- 024_template_lifecycle.sql — template submit-to-Meta linkage (roadmap A3).
-- meta_template_id records the Graph template id once a locally created
-- template is submitted (or when a sync pull matches a remote template).
-- NULL means the template has never been submitted to Meta.
ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS meta_template_id TEXT;
