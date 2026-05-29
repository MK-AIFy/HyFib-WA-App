# Runbook: OpenSearch Security

The base compose runs OpenSearch with `DISABLE_SECURITY_PLUGIN=true` for local
convenience. The production overlay enables the security plugin.

## Enable

`docker-compose.prod.yml` sets:

```
DISABLE_SECURITY_PLUGIN=false
OPENSEARCH_INITIAL_ADMIN_PASSWORD=${OPENSEARCH_ADMIN_PASSWORD}
```

Set a strong `OPENSEARCH_ADMIN_PASSWORD` (min 8 chars, mixed case, digit, symbol).

## Post-install

1. Change the admin password; create least-privilege internal users / roles for
   log ingestion (write-only) and Grafana (read-only).
2. Enable TLS on the transport and REST layers (provide node + admin certs).
3. Restrict the `9200` port to the data network; do not expose it publicly.
4. Point service log shippers at OpenSearch using the write-only credentials.

## Verify

```bash
curl -k -u admin:$OPENSEARCH_ADMIN_PASSWORD https://localhost:9200/_cluster/health
```
