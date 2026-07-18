curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "spend",
    "idempotencyKey": "idem_0",
    "actor": { "kind": "user", "userId": "usr_buyer" },
    "orderId": "ord_1",
    "buyerId": "usr_buyer",
    "sku": "wrld_pass",
    "price": "CREDIT:4.00",
    "recipients": [{ "sellerId": "usr_seller", "shareBps": 10000 }]
  }'
