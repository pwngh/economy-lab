curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "adjust",
    "idempotencyKey": "idem_0",
    "actor": { "kind": "operator", "operatorId": "op_1" },
    "account": "usr_alice:spendable",
    "amount": "CREDIT:2.50",
    "reason": "reconciliation: missing genesis lot"
  }'
