curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "subscribe",
    "idempotencyKey": "idem_1",
    "actor": { "kind": "user", "userId": "usr_a" },
    "userId": "usr_a",
    "sellerId": "usr_s",
    "sku": "club_pass",
    "price": "CREDIT:500.00",
    "periodMs": 2592000000
  }'
