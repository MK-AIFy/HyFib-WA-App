# Security and Compliance Controls

## Regulatory Baseline

- GDPR controls for lawful basis, minimization, retention, subject rights.
- India DPDP controls for notice/consent, purpose limitation, breach handling.

## Core Data Controls

1. Consent ledger (immutable):
- Contact ID
- Channel
- Source and capture timestamp
- Policy version
- Revocation timestamp and reason

2. Data minimization:
- Store only required contact and message metadata.
- Configurable retention with legal hold exceptions.

3. Encryption:
- TLS 1.3 in transit.
- Encrypted storage for DB, object store, and backups.
- Field-level encryption for sensitive attributes.

## Messaging Policy Controls

- Reject business-initiated sends without valid consent.
- Enforce approved template use outside the customer service window.
- Enforce template category integrity (marketing cannot pass as utility/auth/service).
- Process STOP/opt-out signals immediately with suppression update.

## AppSec and SDLC Controls

- ASVS L2 baseline for all services.
- ASVS L3 controls on auth, PII, and payment-affecting paths.
- SAST/DAST/SCA and secret scanning in CI.
- Artifact signing and provenance checks.

## Operational Security

- Quarterly threat modeling.
- 90-day key rotation.
- Break-glass access with full immutable audit trail.
- Incident runbooks for webhook abuse, token compromise, and policy drift.

## AI Governance Controls

- AI provider treated as third-party processor support.
- No model-training rights on Business Solution Data.
- Prompt redaction of PII before outbound AI requests.
- Response traceability with approval checkpoints for high-impact actions.
