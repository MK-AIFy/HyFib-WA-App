# Application runtime policy: read-only scoped access to tenant and integration secrets.
path "secret/data/hyfib/*" {
  capabilities = ["read", "list"]
}

# Allow token lookup for diagnostics.
path "auth/token/lookup-self" {
  capabilities = ["read"]
}

# Deny write by default; use dedicated CI/CD role for rotations.
path "secret/data/hyfib" {
  capabilities = ["deny"]
}
