curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "adjust",
    "idempotencyKey": "recon_2026_07_usr_alice",
    "actor": { "kind": "operator", "operatorId": "op_1" },
    "account": "usr_alice:spendable",
    "amount": "CREDIT:250.00",
    "reason": "reconciliation: missing genesis lot"
  }'
# → { "status": "committed", "transaction": { "id": "txn_…", … } }
