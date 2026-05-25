# Operational Gaps and Next Hardening Actions

This implementation provides a production-grade foundation, but these items must be completed before true internet production.

## 1) Replace Lab Defaults

- Replace Vault dev mode with HA integrated storage and auto-unseal.
- Replace Keycloak `start-dev` with production mode and external DB TLS.
- Enable OpenSearch security plugin and authenticated transport.

## 2) Edge and TLS Hardening

- Add TLS 1.3 certificates and strict cipher suites at edge.
- Enforce Meta webhook source allowlisting with regularly updated CIDRs.
- Add WAF managed rules and DDoS controls at perimeter.

## 3) Queue/Event Transport

- Replace in-memory event fallback with RabbitMQ durable publishers/consumers.
- Add DLQ routing and retry backoff policies per topic.

## 4) Data and Key Management

- Implement tenant-specific envelope encryption keys from Vault transit.
- Add retention jobs, legal hold controls, and immutable audit storage target.

## 5) Runtime Verification

- Run container image scanning (Trivy/Grype) in CI and release gates.
- Run DAST against edge endpoints and webhook abuse scenarios.
- Execute DR drill to validate RPO/RTO objectives with evidence.
