curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "refund",
    "idempotencyKey": "idem_refund_1",
    "actor": { "kind": "system", "service": "support" },
    "orderId": "ord_1",
    "reason": "changed mind"
  }'
