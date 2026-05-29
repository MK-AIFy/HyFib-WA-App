-- Per-campaign delivery progress, updated by the campaign.dispatch.result consumer.
CREATE TABLE IF NOT EXISTS campaign_stats (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  sent_count BIGINT NOT NULL DEFAULT 0,
  failed_count BIGINT NOT NULL DEFAULT 0,
  last_result_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, campaign_id)
);

ALTER TABLE campaign_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_stats FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_stats_tenant_isolation ON campaign_stats
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
