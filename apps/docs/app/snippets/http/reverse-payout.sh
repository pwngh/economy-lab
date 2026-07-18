curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "reversePayout",
    "idempotencyKey": "idem_0",
    "actor": { "kind": "operator", "operatorId": "op_1" },
    "userId": "usr_seller",
    "sagaId": "pay_1",
    "reason": "fraud hold"
  }'
