# Vault production server configuration (single-node raft).
# For a real HA deployment, run 3+ nodes and join them into one raft cluster
# (see docs/runbooks/vault-init-unseal.md). Terminate TLS at this listener or
# at the edge proxy depending on your network topology.

ui = true

storage "raft" {
  path    = "/vault/data"
  node_id = "hyfib-vault-1"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  # Set tls_disable = 0 and provide certs in production networks without an
  # internal TLS-terminating mesh.
  tls_disable = 1
}

api_addr     = "http://vault:8200"
cluster_addr = "http://vault:8201"

# Use auto-unseal (e.g. transit / cloud KMS) in production instead of manual
# Shamir unseal where an HSM/KMS is available.
