curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "revokeEntitlement",
    "idempotencyKey": "idem_revoke_1",
    "actor": { "kind": "system", "service": "fulfillment" },
    "userId": "usr_owner",
    "sku": "wrld_pass",
    "reason": "chargeback"
  }'
