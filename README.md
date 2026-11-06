# carrivo-backend

## Authentication

Every protected route takes `Authorization: Bearer <token>`. Tokens come from
`POST /api/v1/auth/register`, `POST /api/v1/auth/login` or the Google flow below.
Role is never client-settable: new accounts (including Google ones) are `CUSTOMER`.

### Google sign-in

A browser flow that ends in the same `{ token, expiresAt, user }` response as login.
No token is ever put in a URL or a redirect:

1. The frontend creates a random `codeVerifier`, keeps it (sessionStorage), and
   navigates the browser to
   `GET /api/v1/auth/google?challenge=<base64url(SHA-256(codeVerifier)), no padding>`.
2. The user signs in at Google, which redirects to `/api/v1/auth/callback/google`.
3. The API redirects to `FRONTEND_URL/auth/google/callback?code=<one-time code>`,
   or `?error=account_exists | account_deactivated | google_cancelled | google_failed`.
4. The frontend calls `POST /api/v1/auth/google/exchange` with
   `{ "code": "...", "codeVerifier": "..." }` within 60 seconds. The code works once.

`account_exists` means the email already has an account. Google sign-in never links
to an existing account; sign in with the password instead.

Frontend paths used in redirects and email links live in
`src/app/config/frontendRoutes.ts`.

#### Setup

Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application),
**Authorized redirect URIs**:

- `http://localhost:5000/api/v1/auth/callback/google`
- `https://<your-api>.vercel.app/api/v1/auth/callback/google`

No Authorized JavaScript origins are needed. Set `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_URL` (exactly the API origin) and `FRONTEND_URL`
(the frontend origin) locally and in Vercel.

#### Manual test without a frontend

With the API running (`npm run dev`):

```bash
# 1. Verifier and S256 challenge (base64url, no padding)
VERIFIER=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
echo "Open in a browser: http://localhost:5000/api/v1/auth/google?challenge=$CHALLENGE"
```

2. Open the printed URL and sign in with Google. The browser ends on
   `http://localhost:3000/auth/google/callback?code=...`. The page doesn't need to
   exist: copy the `code` value from the address bar.
3. Within 60 seconds, in the same terminal:

```bash
CODE='<paste the code>'
curl -s -X POST http://localhost:5000/api/v1/auth/google/exchange \
  -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"codeVerifier\":\"$VERIFIER\"}"
```

The response holds the Bearer token. Postman: **Auth → Google: exchange code**, with
the `googleCode` and `googleCodeVerifier` collection variables.
