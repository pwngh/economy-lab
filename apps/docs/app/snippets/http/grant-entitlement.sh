curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "grantEntitlement",
    "idempotencyKey": "comp_usr_owner_wrld_pass",
    "actor": { "kind": "system", "service": "fulfillment" },
    "userId": "usr_owner",
    "sku": "wrld_pass"
  }'
# → { "status": "committed", "transaction": { "id": "txn_…", … } }
