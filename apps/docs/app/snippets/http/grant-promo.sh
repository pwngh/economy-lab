curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "grantPromo",
    "idempotencyKey": "promo_2026_06_27_usr_buyer",
    "actor": { "kind": "system", "service": "marketing" },
    "userId": "usr_buyer",
    "amount": "CREDIT:5.00",
    "expiresAt": 1798761600000
  }'
