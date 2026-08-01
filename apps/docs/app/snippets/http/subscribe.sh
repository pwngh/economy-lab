curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "subscribe",
    "idempotencyKey": "sub_usr_a_club_pass",
    "actor": { "kind": "user", "userId": "usr_a" },
    "userId": "usr_a",
    "sellerId": "usr_s",
    "sku": "club_pass",
    "price": "CREDIT:500.00",
    "periodMs": 2592000000
  }'
# → { "status": "committed", "transaction": { "id": "txn_…", … } }
