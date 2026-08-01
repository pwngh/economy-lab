curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "reverse",
    "idempotencyKey": "undo_txn_1",
    "actor": { "kind": "operator", "operatorId": "op_1" },
    "txnId": "txn_1",
    "reason": "reconciliation: duplicate posting"
  }'
# → { "status": "committed", "transaction": { "id": "txn_…", … } }
