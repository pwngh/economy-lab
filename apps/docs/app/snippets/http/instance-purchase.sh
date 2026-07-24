curl -s https://economy.example/instances/wrld_1043/purchase \
  -H 'content-type: application/json' \
  -d '{
    "buyerId": "usr_buyer",
    "price": "CREDIT:300.00",
    "recipients": [{ "sellerId": "usr_creator", "shareBps": 10000 }],
    "product": { "sku": "wrld_1043:jetpack", "kind": "permanent" }
  }'
