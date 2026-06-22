# Economy Console

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
DATABASE_URL=postgresql://user@localhost:5432/economy_lab npm run dev

# MySQL
DATABASE_URL=mysql://user@localhost:3306/economy_lab npm run dev
```
