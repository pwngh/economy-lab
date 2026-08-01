curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "reversePayout",
    "idempotencyKey": "unwind_pay_1",
    "actor": { "kind": "operator", "operatorId": "op_1" },
    "userId": "usr_seller",
    "sagaId": "pay_1",
    "reason": "fraud hold"
  }'
# → { "status": "committed", "transaction": { "id": "txn_…", … } }
