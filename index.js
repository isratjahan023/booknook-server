require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

const authURL = (
  process.env.AUTH_URL || "http://localhost:3000"
).replace(/\/$/, "");

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

const categories = ["Fiction", "Science", "History", "Kids", "Others"];

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function objectId(value) {
  if (!/^[a-fA-F0-9]{24}$/.test(String(value))) {
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
  return String(error.message).replace(
    /mongodb(?:\+srv)?:\/\/[^\s]+/gi,
    "[connection string hidden]"
  );
}

async function startServer() {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is missing");
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

    const { createRemoteJWKSet, jwtVerify } = await import("jose");

    const JWKS = createRemoteJWKSet(
      new URL(`${authURL}/api/auth/jwks`)
    );

    async function requireAuth(req, res, next) {
      const authorization = req.get("authorization") || "";

      if (!authorization.startsWith("Bearer ")) {
        return res.status(401).json({
          message: "Please log in to continue",
        });
      }

      try {
        const { payload } = await jwtVerify(
          authorization.slice(7),
          JWKS,
          {
            issuer: authURL,
            audience: authURL,
          }
        );

        if (
          typeof payload.sub !== "string" ||
          typeof payload.email !== "string"
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

        next();
      } catch (error) {
        console.error("JWT verification:", error.code || error.name);

        const infrastructureError =
          error.code === "ERR_JWKS_TIMEOUT" ||
          error.name === "TypeError";

        res.status(infrastructureError ? 503 : 401).json({
          message: infrastructureError
            ? "Authentication service unavailable. Please retry."
            : "Session expired. Please log in again.",
        });
      }
    }

    // Public listing, latest arrivals and authenticated user's books.
    // /books?limit=6
    // /books?mine=true
    app.get(
      "/books",
      (req, res, next) => {
        if (req.query.mine === "true") {
          return requireAuth(req, res, next);
        }

        next();
      },
      async (req, res) => {
        const filter =
          req.query.mine === "true"
            ? { ownerId: req.user.id }
            : {};

        let query = books
          .find(filter)
          .sort({ createdAt: -1, _id: -1 });

        if (req.query.limit !== undefined) {
          const limit = Number(req.query.limit);

          if (
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 100
          ) {
            fail(400, "Limit must be between 1 and 100");
          }

          query = query.limit(limit);
        }

        res.json(await query.toArray());
      }
    );

    // Private book details.
    app.get("/books/:id", requireAuth, async (req, res) => {
      const book = await books.findOne({
        _id: objectId(req.params.id),
      });

      if (!book) fail(404, "Book not found");

      res.json(book);
    });

    // Add book. Identity comes from verified JWT.
    app.post("/books", requireAuth, async (req, res) => {
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
        book: { ...book, _id: result.insertedId },
      });
    });

    // Edit own book while preserving borrowed-copy count.
    app.patch("/books/:id", requireAuth, async (req, res) => {
      const id = objectId(req.params.id);
      const input = bookInput(req.body || {});

      await client.withSession(async (session) => {
        await session.withTransaction(async () => {
          const book = await books.findOne(
            { _id: id },
            { session }
          );

          if (!book) fail(404, "Book not found");

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

      res.json({ message: "Book updated successfully" });
    });

    // Delete own book only when no copies are borrowed.
    app.delete("/books/:id", requireAuth, async (req, res) => {
      const id = objectId(req.params.id);

      await client.withSession(async (session) => {
        await session.withTransaction(async () => {
          const book = await books.findOne(
            { _id: id },
            { session }
          );

          if (!book) fail(404, "Book not found");

          if (book.ownerId !== req.user.id) {
            fail(403, "You can delete only your own books");
          }

          const activeBorrow = await borrows.findOne(
            { bookId: id },
            { session }
          );

          if (activeBorrow) {
            fail(409, "This book has borrowed copies. Return them first.");
          }

          await books.deleteOne({ _id: id }, { session });
        });
      });

      res.json({ message: "Book deleted successfully" });
    });

    // Atomic borrow: decrement copy + insert borrow together.
    app.post("/borrows", requireAuth, async (req, res) => {
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
            { $inc: { availableCopies: -1 } },
            {
              session,
              returnDocument: "after",
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
    });

    // Current user's active borrows.
    app.get("/borrows", requireAuth, async (req, res) => {
      const result = await borrows
        .find({ userId: req.user.id })
        .sort({ borrowDate: -1 })
        .toArray();

      res.json(result);
    });

    // Atomic return: remove borrow + restore copy together.
    app.delete("/borrows/:id", requireAuth, async (req, res) => {
      const id = objectId(req.params.id);

      await client.withSession(async (session) => {
        await session.withTransaction(async () => {
          const borrow = await borrows.findOneAndDelete(
            { _id: id, userId: req.user.id },
            { session }
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

      res.json({ message: "Book returned successfully" });
    });

    app.use((req, res) => {
      res.status(404).json({ message: "Route not found" });
    });

    app.use((error, req, res, next) => {
      console.error("API error:", safeMessage(error));

      if (error.code === 11000) {
        return res.status(409).json({
          message: "You have already borrowed this book",
        });
      }

      const status = error.status || 500;

      res.status(status).json({
        message:
          status < 500
            ? error.message
            : "Server error. Please try again.",
      });
    });

    app.listen(port, () => {
      console.log("MongoDB connected successfully.");
      console.log(`BookNook server: http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Server startup failed:", safeMessage(error));
    await client.close();
    process.exitCode = 1;
  }
}

startServer();