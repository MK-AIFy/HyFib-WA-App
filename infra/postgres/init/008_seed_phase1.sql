-- Phase 1 baseline seed data.

INSERT INTO rbac_role_bundles (key, label, roles)
VALUES
  ('owner', 'Owner', ARRAY['platform_owner', 'tenant_admin', 'marketing_manager', 'sales_agent', 'support_agent']),
  ('admin', 'Admin', ARRAY['tenant_admin', 'marketing_manager']),
  ('agent', 'Agent', ARRAY['sales_agent', 'support_agent']),
  ('viewer', 'Viewer', ARRAY['analyst', 'compliance_auditor'])
ON CONFLICT (key) DO UPDATE
SET label = EXCLUDED.label,
    roles = EXCLUDED.roles;
