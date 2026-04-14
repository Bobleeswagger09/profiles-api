# Profiles API

A REST API that aggregates data from Genderize, Agify, and Nationalize APIs, stores profiles in PostgreSQL, and supports idempotent requests.

## Live API

> Base URL: `https://YOUR-APP.onrender.com`

## Endpoints

### POST /api/profiles

Creates a new profile by name.

**Request:**

```json
{ "name": "ella" }
```

**Success (201):**

```json
{
  "status": "success",
  "data": {
    "id": "uuid-v7",
    "name": "ella",
    "gender": "female",
    "gender_probability": 0.99,
    "sample_size": 1234,
    "age": 46,
    "age_group": "adult",
    "country_id": "DRC",
    "country_probability": 0.85,
    "created_at": "2026-04-01T12:00:00.000Z"
  }
}
```

**Idempotent (200):** Returns existing profile with `"message": "Profile already exists"`

### GET /api/profiles

Returns all stored profiles.

### GET /api/profiles/:id

Returns a single profile by ID.

## Error Codes

| Status | Cause                   |
| ------ | ----------------------- |
| `400`  | Missing or empty `name` |
| `422`  | `name` is not a string  |
| `404`  | Profile not found       |
| `502`  | External API timeout    |
| `500`  | Internal server error   |

## Run Locally

```bash
# 1. Clone repo
git clone https://github.com/YOUR_USERNAME/profiles-api.git
cd profiles-api

# 2. Install dependencies
npm install

# 3. Set environment variables
cp .env.example .env
# Edit .env with your PostgreSQL URL

# 4. Start server
npm run dev
```

## Deploy on Render

1. Push to GitHub (public repo)
2. Go to render.com → New → Web Service
3. Connect repo, set:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Add environment variable: `DATABASE_URL` (from Render PostgreSQL)
5. Deploy

## Tech Stack

- Node.js + Express 4
- PostgreSQL (via `pg`)
- UUID v7 (`uuid` package)
- Axios
