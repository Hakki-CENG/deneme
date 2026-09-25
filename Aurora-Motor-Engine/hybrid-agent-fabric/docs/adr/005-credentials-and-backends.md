# ADR-005: Credentials and backend registry remain server-side

Status: accepted

## Decision

Browser clients never persist backend API keys. Backend records contain only a
server-side environment reference. Local secrets are AES-256-GCM encrypted and
are usable by capability workers only through short-lived scoped leases.
Production deployments replace the local encrypted file with Vault/KMS while
retaining the same broker contract.

## Consequences

- XSS cannot read backend or provider keys from localStorage.
- Model and Python contexts never receive long-lived credentials.
- A lease is bound to tenant, capability, audience, expiration and use count.
- Backend health checks and proxy calls are made by the BFF.
