curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "refund",
    "idempotencyKey": "refund_ord_1",
    "actor": { "kind": "system", "service": "support" },
    "orderId": "ord_1",
    "reason": "changed mind"
  }'
# → { "status": "committed", "transaction": { "id": "txn_…", … } }
