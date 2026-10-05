# OntoConsens

OntoConsens is an LLM-based proactive moderator that supports consensus building in collaborative Ontology Engineering (OE). Following the DILIGENT methodology, group members propose properties for the classes of an ontology and discuss each property proposal in a synchronous session, arguing for or against it with examples and counterexamples. When the discussion stalls, the AI moderator intervenes by showing a disagreement visualization, which organizes the examples and counterexamples raised so far and who raised them. The AI moderator does not contribute its own opinions or take part in decisions.

## Getting Started

### Prerequisites

- Node.js 24
- pnpm
- A PostgreSQL database
- An OpenAI API key with access to the configured models

### Installation

From the repository root:

```bash
pnpm install
```

### Environment Configuration

Set the following environment variables through your environment or workspace secrets manager.

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Secret used to derive the encryption key for stored OpenAI API keys |
| `PORT` | Port for the service being started |
| `BASE_PATH` | Frontend base path; `/` for the main application |

OpenAI API keys are entered in the application, at registration or in account settings. The key of the group member who creates a project is used for all AI requests in that project, and is stored encrypted.

### Database Setup

Apply the schema to your development database:

```bash
pnpm --filter @workspace/db run push
```

This command changes the schema of the connected database. Review the proposed changes before accepting them, and do not run it against a production database without a migration plan.

### Run the Application

Start the backend and frontend in separate terminals:

```bash
# Backend
PORT=8080 pnpm --filter @workspace/api-server run dev

# Frontend
PORT=19982 BASE_PATH=/ pnpm --filter @workspace/onto-consensus run dev
```

The workspace serves the frontend at `/`, the HTTP API at `/api`, and WebSocket connections at `/ws`. Outside the workspace, configure a reverse proxy to serve these routes from the same origin.

The backend development command builds the server before starting it, so restart it after backend changes. Frontend changes are applied by Vite's hot reload.
