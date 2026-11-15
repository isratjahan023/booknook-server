require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

const authURL = (
  process.env.AUTH_URL || "http://localhost:3000"
).trim().replace(/\/+$/, "");

const clientURL = (
  process.env.CLIENT_URL || "http://localhost:3000"
).trim().replace(/\/+$/, "");

app.use(
  cors({
    origin: clientURL,
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

const categories = ["Fiction", "Science", "History", "Kids", "Others"];

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function objectId(value) {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{24}$/.test(value)) {
    fail(400, "Invalid ID");
  }

  return new ObjectId(value);
}

function text(value, field, maxLength) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maxLength
  ) {
    fail(400, `Please enter a valid ${field}`);
  }

  return value.trim();
}

function bookInput(body) {
  const title = text(body.title, "book title", 200);
  const author = text(body.author, "author name", 150);
  const description = text(body.description, "description", 5000);
  const image = text(body.image, "image URL", 2000);

  let imageURL;

  try {
    imageURL = new URL(image);
  } catch {
    fail(400, "Invalid image URL");
  }

  if (!["https:", "http:"].includes(imageURL.protocol)) {
    fail(400, "Image must use an HTTP or HTTPS URL");
  }

  if (!categories.includes(body.category)) {
    fail(400, "Please select a valid category");
  }

  if (
    !Number.isSafeInteger(body.totalCopies) ||
    body.totalCopies < 1 ||
    body.totalCopies > 10000
  ) {
    fail(400, "Total copies must be between 1 and 10000");
  }

  return {
    title,
    author,
    description,
    image,
    category: body.category,
    totalCopies: body.totalCopies,
  };
}

function safeMessage(error) {
  return String(error?.message || error).replace(
    /mongodb(?:\+srv)?:\/\/[^\s]+/gi,
    "[connection string hidden]"
  );
}

async function startServer() {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is missing from server .env");
    process.exitCode = 1;
    return;
  }

  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });

  try {
    await client.connect();

    const db = client.db(process.env.DB_NAME || "booknook");
    await db.command({ ping: 1 });

    const books = db.collection("books");
    const borrows = db.collection("borrows");

    await books.createIndex({ createdAt: -1, _id: -1 });
    await books.createIndex({ ownerId: 1 });

    await borrows.createIndex(
      { userId: 1, bookId: 1 },
      { unique: true }
    );

    await borrows.createIndex({ userId: 1, borrowDate: -1 });

    const { createRemoteJWKSet, jwtVerify } = await import("jose");

    const jwksURL = new URL(`${authURL}/api/auth/jwks`);
    const JWKS = createRemoteJWKSet(jwksURL);

    async function requireAuth(req, res, next) {
      const authorization = req.get("authorization") || "";
      const match = authorization.match(/^Bearer\s+(\S+)$/i);

      if (!match) {
        return res.status(401).json({
          message: "Please log in to continue",
        });
      }

      try {
        const { payload } = await jwtVerify(match[1], JWKS, {
          issuer: authURL,
          audience: authURL,
        });

        if (
          typeof payload.sub !== "string" ||
          !payload.sub ||
          typeof payload.email !== "string" ||
          !payload.email
        ) {
          return res.status(401).json({
            message: "Invalid account token",
          });
        }

        req.user = {
          id: payload.sub,
          email: payload.email,
          name:
            typeof payload.name === "string"
              ? payload.name
              : payload.email,
        };
      } catch (error) {
        // Log error codes only; never log tokens.
        console.error("JWT verification failed:", {
          code: error.code || error.name,
          cause: error.cause?.code,
          jwksURL: jwksURL.href,
        });

        const infrastructureError =
          error.code === "ERR_JWKS_TIMEOUT" ||
          error.code === "ERR_JWKS_INVALID" ||
          error.code === "ERR_JOSE_GENERIC" ||
          error.name === "TypeError";

        return res.status(infrastructureError ? 503 : 401).json({
          message: infrastructureError
            ? "Authentication service unavailable. Please retry."
            : "Session expired or invalid. Please log in again.",
        });
      }

      next();
    }

    // 1. All books / latest books / current user's books.
    app.get(
      "/books",
      (req, res, next) => {
        if (req.query.mine === "true") {
          return requireAuth(req, res, next);
        }

        next();
      },
      asyncHandler(async (req, res) => {
        const filter =
          req.query.mine === "true"
            ? { ownerId: req.user.id }
            : {};

        let query = books
          .find(filter)
          .sort({ createdAt: -1, _id: -1 });

        if (req.query.limit !== undefined) {
          if (typeof req.query.limit !== "string") {
            fail(400, "Invalid limit");
          }

          const limit = Number(req.query.limit);

          if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            fail(400, "Limit must be between 1 and 100");
          }

          query = query.limit(limit);
        }

        res.json(await query.toArray());
      })
    );

    // 2. Book details — private.
    app.get(
      "/books/:id",
      requireAuth,
      asyncHandler(async (req, res) => {
        const book = await books.findOne({
          _id: objectId(req.params.id),
        });

        if (!book) {
          fail(404, "Book not found");
        }

        res.json(book);
      })
    );

    // 3. Add book — private.
    app.post(
      "/books",
      requireAuth,
      asyncHandler(async (req, res) => {
        const input = bookInput(req.body || {});

        const book = {
          ...input,
          availableCopies: input.totalCopies,
          ownerId: req.user.id,
          userName: req.user.name,
          userEmail: req.user.email,
          createdAt: new Date(),
        };

        const result = await books.insertOne(book);

        res.status(201).json({
          message: "Book added successfully",
          book: {
            ...book,
            _id: result.insertedId,
          },
        });
      })
    );

    // 4. Update own book — private.
    app.patch(
      "/books/:id",
      requireAuth,
      asyncHandler(async (req, res) => {
        const id = objectId(req.params.id);
        const input = bookInput(req.body || {});

        await client.withSession(async (session) => {
          await session.withTransaction(async () => {
            const book = await books.findOne(
              { _id: id },
              { session }
            );

            if (!book) {
              fail(404, "Book not found");
            }

            if (book.ownerId !== req.user.id) {
              fail(403, "You can edit only your own books");
            }

            const borrowed =
              book.totalCopies - book.availableCopies;

            if (input.totalCopies < borrowed) {
              fail(
                400,
                `At least ${borrowed} copies are currently borrowed`
              );
            }

            await books.updateOne(
              { _id: id, ownerId: req.user.id },
              {
                $set: {
                  ...input,
                  availableCopies: input.totalCopies - borrowed,
                  updatedAt: new Date(),
                },
              },
              { session }
            );
          });
        });

        res.json({
          message: "Book updated successfully",
        });
      })
    );

    // 5. Delete own book — private.
    app.delete(
      "/books/:id",
      requireAuth,
      asyncHandler(async (req, res) => {
        const id = objectId(req.params.id);

        await client.withSession(async (session) => {
          await session.withTransaction(async () => {
            const book = await books.findOne(
              { _id: id },
              { session }
            );

            if (!book) {
              fail(404, "Book not found");
            }

            if (book.ownerId !== req.user.id) {
              fail(403, "You can delete only your own books");
            }

            const activeBorrow = await borrows.findOne(
              { bookId: id },
              { session }
            );

            if (activeBorrow) {
              fail(
                409,
                "This book has borrowed copies. Return them first."
              );
            }

            await books.deleteOne(
              { _id: id, ownerId: req.user.id },
              { session }
            );
          });
        });

        res.json({
          message: "Book deleted successfully",
        });
      })
    );

    // 6. Borrow a book — private.
    app.post(
      "/borrows",
      requireAuth,
      asyncHandler(async (req, res) => {
        const bookId = objectId(req.body?.bookId);

        await client.withSession(async (session) => {
          await session.withTransaction(async () => {
            const existing = await borrows.findOne(
              { userId: req.user.id, bookId },
              { session }
            );

            if (existing) {
              fail(409, "You have already borrowed this book");
            }

            const book = await books.findOneAndUpdate(
              {
                _id: bookId,
                availableCopies: { $gt: 0 },
              },
              {
                $inc: { availableCopies: -1 },
              },
              {
                session,
                returnDocument: "after",
                includeResultMetadata: false,
              }
            );

            if (!book) {
              fail(409, "Book not available");
            }

            const borrowDate = new Date();
            const returnDate = new Date(
              borrowDate.getTime() + 7 * 24 * 60 * 60 * 1000
            );

            await borrows.insertOne(
              {
                bookId,
                bookTitle: book.title,
                bookImage: book.image,
                userId: req.user.id,
                userName: req.user.name,
                userEmail: req.user.email,
                borrowDate,
                returnDate,
              },
              { session }
            );
          });
        });

        res.status(201).json({
          message: "Book borrowed successfully",
        });
      })
    );

    // 7. Current user's borrows — private.
    app.get(
      "/borrows",
      requireAuth,
      asyncHandler(async (req, res) => {
        const result = await borrows
          .find({ userId: req.user.id })
          .sort({ borrowDate: -1 })
          .toArray();

        res.json(result);
      })
    );

    // 8. Return a book — private.
    app.delete(
      "/borrows/:id",
      requireAuth,
      asyncHandler(async (req, res) => {
        const id = objectId(req.params.id);

        await client.withSession(async (session) => {
          await session.withTransaction(async () => {
            const borrow = await borrows.findOneAndDelete(
              { _id: id, userId: req.user.id },
              {
                session,
                includeResultMetadata: false,
              }
            );

            if (!borrow) {
              fail(404, "Borrow record not found");
            }

            const result = await books.updateOne(
              { _id: borrow.bookId },
              { $inc: { availableCopies: 1 } },
              { session }
            );

            if (result.matchedCount !== 1) {
              fail(409, "Book missing. Could not complete return.");
            }
          });
        });

        res.json({
          message: "Book returned successfully",
        });
      })
    );

    app.use((req, res) => {
      res.status(404).json({
        message: "Route not found",
      });
    });

    app.use((error, req, res, next) => {
      if (res.headersSent) {
        return next(error);
      }

      console.error("API error:", safeMessage(error));

      if (error.code === 11000) {
        return res.status(409).json({
          message: "A duplicate record already exists.",
        });
      }

      const requestedStatus = Number(error.status);

      const status =
        Number.isInteger(requestedStatus) &&
        requestedStatus >= 400 &&
        requestedStatus <= 599
          ? requestedStatus
          : 500;

      let message = "Server error. Please try again.";

      if (error.type === "entity.parse.failed") {
        message = "Invalid JSON request body";
      } else if (error.type === "entity.too.large") {
        message = "Request body is too large";
      } else if (status < 500) {
        message = error.message;
      }

      res.status(status).json({ message });
    });

    app.listen(port, () => {
      console.log("MongoDB connected successfully.");
      console.log(`BookNook server: http://localhost:${port}`);
      console.log(`Client origin: ${clientURL}`);
      console.log(`Authentication keys: ${jwksURL.href}`);
    });
  } catch (error) {
    console.error("Server startup failed:", safeMessage(error));
    await client.close();
    process.exitCode = 1;
  }
}

startServer();