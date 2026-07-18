curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "grantEntitlement",
    "idempotencyKey": "idem_0",
    "actor": { "kind": "system", "service": "fulfillment" },
    "userId": "usr_owner",
    "sku": "wrld_pass"
  }'
