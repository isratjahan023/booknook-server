# BookNook Server

Express and MongoDB backend for a small community lending library.

## Features

- Browse books with newest-first sorting and a latest-books limit.
- Protect private APIs with BetterAuth JWT verification.
- Add books and allow owners to edit or delete their books.
- Borrow and return books using MongoDB transactions.
- Track available copies and prevent duplicate active borrows.
- Validate book fields, categories, copy counts and IDs.

## Technology

Node.js 22, Express 5, MongoDB, jose, CORS and dotenv.

## Local Setup

1. Run `npm install`.
2. Copy `.env.example` to `.env`.
3. Enter your MongoDB connection string.
4. Set CLIENT_URL and AUTH_URL to the Next.js client URL.
5. Run `npm run dev`.

Production start command: `npm start`.

MongoDB must support transactions, such as MongoDB Atlas.

## Environment Variables

- PORT: API listening port.
- CLIENT_URL: allowed frontend origin.
- AUTH_URL: BetterAuth base URL and JWT issuer/audience.
- DB_NAME: database name.
- MONGODB_URI: private MongoDB connection string.

## API Routes

| Method | Route | Access |
| --- | --- | --- |
| GET | /books | Public |
| GET | /books/:id | Authenticated |
| POST | /books | Authenticated |
| PATCH | /books/:id | Book owner |
| DELETE | /books/:id | Book owner |
| POST | /borrows | Authenticated |
| GET | /borrows | Current user |
| DELETE | /borrows/:id | Borrow owner |

Use `/books?limit=6` for latest arrivals.
Use `/books?mine=true` with authentication for the user's own books.

Protected requests require an Authorization Bearer JWT.

## Borrowing Rules

Loans last seven days. Borrowing decreases available copies by one;
returning restores one copy. Duplicate active borrows are blocked.
Books with active borrows cannot be deleted.