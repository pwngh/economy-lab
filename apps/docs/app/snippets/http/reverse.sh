curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "reverse",
    "idempotencyKey": "idem_0",
    "actor": { "kind": "operator", "operatorId": "op_1" },
    "txnId": "txn_1",
    "reason": "reconciliation: duplicate posting"
  }'
