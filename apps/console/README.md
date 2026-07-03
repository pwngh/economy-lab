# Economy Console

A demo admin UI for [economy-lab](../../README.md), driven by the live engine: browse accounts and
the double-entry ledger, watch payouts move through their saga, and check solvency on the Integrity
page. The collapsible Simulation panel at the foot of every page advances time, runs the background
jobs, and toggles a payment-provider outage; it seeds demo data on first run.

## Run it

```bash
cd apps/console
npm install        # standalone — installs into apps/console/node_modules
npm run dev        # http://localhost:5173
```

### Scripts

| script              | what it does                                            |
| ------------------- | ------------------------------------------------------- |
| `npm run dev`       | `react-router dev` — HMR dev server                     |
| `npm run build`     | `react-router build` — production client + server build |
| `npm run start`     | serve the build (`react-router-serve`)                  |
| `npm run typecheck` | generate route types, then type-check the app           |

### Run against a real database

Set `DATABASE_URL` to a Postgres or MySQL DSN and the engine uses that adapter on the server
instead of the in-memory store. The DB driver is imported only when the var is set, so the default
memory path pulls in nothing extra.

```bash
# Postgres
DATABASE_URL=postgres://economy:economy@localhost:5432/economy_lab npm run dev

# MySQL
DATABASE_URL=mysql://root:economy@localhost:3306/economy_lab npm run dev
```
