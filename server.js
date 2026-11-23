'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const {
  createDatabase,
  initDatabase,
  generateCoverSvg,
  countPdfPages,
  slugify,
  PUBLIC_DIR,
  UPLOADS_DIR,
  COVERS_DIR,
  BOOKS_DIR,
} = require('./seed');

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'booknest-dev-secret-change-me-in-production';
const JWT_EXPIRES_IN = '7d';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const db = createDatabase();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const handle = (fn) => (req, res, next) => {
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (err) {
    next(err);
  }
};

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function requireId(value, label = 'id') {
  const id = parseId(value);
  if (!id) throw new HttpError(400, `Invalid ${label}.`);
  return id;
}

function clean(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function publicUser(row) {
  return {
    user_id: row.user_id,
    full_name: row.full_name,
    username: row.username,
    email: row.email,
    role: row.role,
    created_at: row.created_at,
  };
}

function signToken(user) {
  return jwt.sign({ sub: user.user_id, role: user.role, username: user.username }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

function uploadsDiskPath(webPath) {
  if (!webPath) return null;
  const abs = path.resolve(PUBLIC_DIR, ...String(webPath).split('/').filter(Boolean));
  return abs.startsWith(UPLOADS_DIR + path.sep) ? abs : null;
}

function safeUnlink(absPath) {
  if (!absPath) return;
  try {
    fs.unlinkSync(absPath);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[booknest] Failed to delete file:', absPath, err.message);
  }
}

function escapeLike(term) {
  return term.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/* ------------------------------------------------------------------ */
/* Prepared statements                                                 */
/* ------------------------------------------------------------------ */

const sql = {
  userById: db.prepare('SELECT * FROM Users WHERE user_id = ?'),
  userByLogin: db.prepare('SELECT * FROM Users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)'),
  userConflict: db.prepare(
    'SELECT LOWER(email) = LOWER(?) AS email_taken, LOWER(username) = LOWER(?) AS username_taken FROM Users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)'
  ),
  insertUser: db.prepare(
    "INSERT INTO Users (full_name, username, email, password_hash, role) VALUES (?, ?, ?, ?, 'user')"
  ),
  stats: db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM Books)      AS total_books,
       (SELECT COUNT(*) FROM Categories) AS total_categories,
       (SELECT COUNT(*) FROM Downloads)  AS total_downloads,
       (SELECT COUNT(*) FROM Users)      AS total_users`
  ),
  categories: db.prepare(
    `SELECT c.category_id, c.category_name, c.slug, c.description, COUNT(b.book_id) AS book_count
     FROM Categories c
     LEFT JOIN Books b ON b.category_id = c.category_id
     GROUP BY c.category_id, c.category_name, c.slug, c.description
     ORDER BY c.category_name ASC`
  ),
  categoryById: db.prepare('SELECT category_id, category_name, slug FROM Categories WHERE category_id = ?'),
  catalogById: db.prepare('SELECT * FROM vw_BookCatalog WHERE book_id = ?'),
  related: db.prepare(
    `SELECT * FROM vw_BookCatalog
     WHERE category_id = ? AND book_id <> ?
     ORDER BY total_downloads DESC, title ASC
     LIMIT 4`
  ),
  bookById: db.prepare('SELECT * FROM Books WHERE book_id = ?'),
  insertDownload: db.prepare('INSERT INTO Downloads (user_id, book_id) VALUES (?, ?)'),
  downloadCount: db.prepare('SELECT COUNT(*) AS total_downloads FROM Downloads WHERE book_id = ?'),
  findBookmark: db.prepare('SELECT bookmark_id FROM Bookmarks WHERE user_id = ? AND book_id = ?'),
  insertBookmark: db.prepare('INSERT INTO Bookmarks (user_id, book_id) VALUES (?, ?)'),
  deleteBookmark: db.prepare('DELETE FROM Bookmarks WHERE bookmark_id = ?'),
  userDownloads: db.prepare(
    `SELECT d.download_id, d.downloaded_at,
            b.book_id, b.title, b.author, b.isbn, b.published_year, b.cover_path, b.file_path,
            c.category_id, c.category_name, c.slug AS category_slug
     FROM Downloads d
     INNER JOIN Books b ON b.book_id = d.book_id
     LEFT JOIN Categories c ON c.category_id = b.category_id
     WHERE d.user_id = ?
     ORDER BY d.downloaded_at DESC, d.download_id DESC`
  ),
  userBookmarks: db.prepare(
    `SELECT bm.bookmark_id, bm.created_at AS bookmarked_at, v.*
     FROM Bookmarks bm
     INNER JOIN vw_BookCatalog v ON v.book_id = bm.book_id
     WHERE bm.user_id = ?
     ORDER BY bm.created_at DESC, bm.bookmark_id DESC`
  ),
  userSummary: db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM Downloads WHERE user_id = ?)                AS total_downloads,
       (SELECT COUNT(DISTINCT book_id) FROM Downloads WHERE user_id = ?) AS unique_books,
       (SELECT COUNT(*) FROM Bookmarks WHERE user_id = ?)                AS total_bookmarks`
  ),
  insertBook: db.prepare(
    `INSERT INTO Books (title, author, isbn, published_year, pages, description, cover_path, file_path, category_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  deleteBook: db.prepare('DELETE FROM Books WHERE book_id = ?'),
  hasDownloaded: db.prepare('SELECT 1 AS ok FROM Downloads WHERE user_id = ? AND book_id = ? LIMIT 1'),
  bookReviews: db.prepare(
    `SELECT r.review_id, r.rating, r.comment, r.created_at, u.user_id, u.full_name, u.username
     FROM Reviews r
     INNER JOIN Users u ON u.user_id = r.user_id
     WHERE r.book_id = ?
       AND EXISTS (SELECT 1 FROM Downloads d WHERE d.user_id = r.user_id AND d.book_id = r.book_id)
     ORDER BY r.created_at DESC, r.review_id DESC
     LIMIT 50`
  ),
  myReview: db.prepare('SELECT review_id, rating, comment, created_at FROM Reviews WHERE user_id = ? AND book_id = ?'),
  upsertReview: db.prepare(
    `INSERT INTO Reviews (user_id, book_id, rating, comment) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, book_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, created_at = CURRENT_TIMESTAMP`
  ),
  bookRating: db.prepare('SELECT avg_rating, review_count FROM Books WHERE book_id = ?'),
  myProgress: db.prepare('SELECT current_page, total_pages, updated_at FROM Reading_Progress WHERE user_id = ? AND book_id = ?'),
  upsertProgress: db.prepare(
    `INSERT INTO Reading_Progress (user_id, book_id, current_page, total_pages) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, book_id) DO UPDATE SET current_page = excluded.current_page, total_pages = excluded.total_pages, updated_at = CURRENT_TIMESTAMP`
  ),
  userProgress: db.prepare(
    `SELECT rp.book_id, b.title, b.author, b.cover_path AS cover_url, rp.current_page, rp.total_pages, rp.updated_at
     FROM Reading_Progress rp
     INNER JOIN Books b ON b.book_id = rp.book_id
     WHERE rp.user_id = ?
     ORDER BY rp.updated_at DESC`
  ),

  // Feature 1: Community Book Requests & Upvotes
  listRequests: db.prepare(
    `SELECT v.*,
            CASE WHEN ? IS NOT NULL AND EXISTS (
              SELECT 1 FROM Request_Votes rv WHERE rv.request_id = v.request_id AND rv.user_id = ?
            ) THEN 1 ELSE 0 END AS user_voted
     FROM vw_BookRequests v
     ORDER BY CASE WHEN v.status = 'open' THEN 0 ELSE 1 END ASC, v.vote_count DESC, v.created_at DESC
     LIMIT 30`
  ),
  requestById: db.prepare('SELECT * FROM Book_Requests WHERE request_id = ?'),
  insertRequest: db.prepare(
    'INSERT INTO Book_Requests (user_id, title, author, isbn, reason) VALUES (?, ?, ?, ?, ?)'
  ),
  findVote: db.prepare('SELECT 1 AS ok FROM Request_Votes WHERE user_id = ? AND request_id = ?'),
  insertVote: db.prepare('INSERT INTO Request_Votes (user_id, request_id) VALUES (?, ?)'),
  deleteVote: db.prepare('DELETE FROM Request_Votes WHERE user_id = ? AND request_id = ?'),
  fulfillRequest: db.prepare(
    "UPDATE Book_Requests SET status = 'fulfilled', fulfilled_book_id = ? WHERE request_id = ?"
  ),

  // Feature 2: Page-Anchored Reading Notes
  bookNotes: db.prepare(
    `SELECT rn.note_id, rn.user_id, rn.book_id, rn.page_number, rn.note_text, rn.is_public, rn.created_at,
            u.full_name, u.username
     FROM Reading_Notes rn
     INNER JOIN Users u ON u.user_id = rn.user_id
     WHERE rn.book_id = ? AND (rn.is_public = 1 OR rn.user_id = ?)
     ORDER BY rn.page_number ASC, rn.created_at DESC
     LIMIT 100`
  ),
  noteById: db.prepare('SELECT * FROM Reading_Notes WHERE note_id = ?'),
  insertNote: db.prepare(
    'INSERT INTO Reading_Notes (user_id, book_id, page_number, note_text, is_public) VALUES (?, ?, ?, ?, ?)'
  ),
  deleteNote: db.prepare('DELETE FROM Reading_Notes WHERE note_id = ? AND user_id = ?'),

  // Feature 3: Reader Leaderboard via SQL Window Function RANK() OVER (...)
  leaderboard: db.prepare(
    `SELECT
       RANK() OVER (
         ORDER BY (
           COALESCE(d.download_count, 0) * 10 +
           COALESCE(r.review_count, 0) * 25 +
           COALESCE(p.pages_read, 0) +
           COALESCE(n.note_count, 0) * 15
         ) DESC, u.created_at ASC
       ) AS rank_pos,
       u.user_id,
       u.full_name,
       u.username,
       COALESCE(d.download_count, 0) AS downloads_count,
       COALESCE(r.review_count, 0)   AS reviews_count,
       COALESCE(p.pages_read, 0)     AS pages_read,
       COALESCE(n.note_count, 0)     AS notes_count,
       (
         COALESCE(d.download_count, 0) * 10 +
         COALESCE(r.review_count, 0) * 25 +
         COALESCE(p.pages_read, 0) +
         COALESCE(n.note_count, 0) * 15
       ) AS engagement_score
     FROM Users u
     LEFT JOIN (SELECT user_id, COUNT(*) AS download_count FROM Downloads GROUP BY user_id) d ON d.user_id = u.user_id
     LEFT JOIN (SELECT user_id, COUNT(*) AS review_count FROM Reviews GROUP BY user_id) r ON r.user_id = u.user_id
     LEFT JOIN (SELECT user_id, SUM(current_page) AS pages_read FROM Reading_Progress GROUP BY user_id) p ON p.user_id = u.user_id
     LEFT JOIN (SELECT user_id, COUNT(*) AS note_count FROM Reading_Notes GROUP BY user_id) n ON n.user_id = u.user_id
     WHERE u.role = 'user'
     ORDER BY rank_pos ASC
     LIMIT 8`
  ),

  auditLogs: db.prepare(
    `SELECT log_id, action_type, entity_type, entity_id, details, created_at
     FROM Audit_Logs ORDER BY created_at DESC, log_id DESC LIMIT 50`
  ),
};

const RECOMMENDATION_SQL = `SELECT b.*, COUNT(*) AS co_downloads
FROM Downloads d1
JOIN Downloads d2 ON d1.user_id = d2.user_id AND d1.book_id != d2.book_id
JOIN vw_BookCatalog b ON d2.book_id = b.book_id
WHERE d1.book_id = ?
GROUP BY b.book_id
ORDER BY COUNT(*) DESC, b.total_downloads DESC
LIMIT 4`;
sql.recommendations = db.prepare(RECOMMENDATION_SQL);

const pdfPageCache = new Map();
function pdfPagesFor(webPath) {
  const disk = uploadsDiskPath(webPath);
  if (!disk) return 0;
  try {
    const { mtimeMs } = fs.statSync(disk);
    const cached = pdfPageCache.get(disk);
    if (cached && cached.mtimeMs === mtimeMs) return cached.pages;
    const pages = countPdfPages(disk);
    pdfPageCache.set(disk, { mtimeMs, pages });
    return pages;
  } catch (err) {
    return 0;
  }
}

function requireInt(value, label, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be a whole number between ${min} and ${max}.`);
  return n;
}

const BOOK_SORTS = {
  newest: 'uploaded_at DESC, book_id DESC',
  popular: 'total_downloads DESC, title COLLATE NOCASE ASC',
  rating: 'avg_rating DESC, review_count DESC, title COLLATE NOCASE ASC',
  title: 'title COLLATE NOCASE ASC, book_id ASC',
};

/* ------------------------------------------------------------------ */
/* Auth middleware                                                     */
/* ------------------------------------------------------------------ */

function readUserFromRequest(req) {
  const header = req.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return { user: null, error: 'Please sign in to continue.' };
  try {
    const payload = jwt.verify(match[1].trim(), JWT_SECRET);
    const user = sql.userById.get(payload.sub);
    if (!user) return { user: null, error: 'Account no longer exists.' };
    return { user, error: null };
  } catch (err) {
    return { user: null, error: err.name === 'TokenExpiredError' ? 'Session expired. Please log in again.' : 'Invalid token.' };
  }
}

function requireAuth(req, res, next) {
  const { user, error } = readUserFromRequest(req);
  if (!user) return res.status(401).json({ error });
  req.user = user;
  next();
}

function optionalAuth(req, res, next) {
  req.user = readUserFromRequest(req).user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
    next();
  });
}

/* ------------------------------------------------------------------ */
/* File uploads (multer)                                               */
/* ------------------------------------------------------------------ */

const COVER_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === 'cover' ? COVERS_DIR : BOOKS_DIR),
    filename: (req, file, cb) => {
      const ext = file.fieldname === 'cover' ? COVER_TYPES[file.mimetype] : '.pdf';
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 2 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'cover') {
      if (COVER_TYPES[file.mimetype]) return cb(null, true);
      return cb(new HttpError(400, 'Cover must be a JPEG, PNG, WebP, GIF or SVG image.'));
    }
    if (file.fieldname === 'bookFile') {
      if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) return cb(null, true);
      return cb(new HttpError(400, 'Book file must be a PDF.'));
    }
    cb(new HttpError(400, `Unexpected file field "${file.fieldname}".`));
  },
}).fields([
  { name: 'cover', maxCount: 1 },
  { name: 'bookFile', maxCount: 1 },
]);

function uploadedFiles(req) {
  const files = req.files || {};
  return { cover: files.cover ? files.cover[0] : null, bookFile: files.bookFile ? files.bookFile[0] : null };
}

function cleanupUploads(req) {
  const { cover, bookFile } = uploadedFiles(req);
  if (cover) safeUnlink(cover.path);
  if (bookFile) safeUnlink(bookFile.path);
}

function isRealPdf(absPath) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    return buf.toString('latin1') === '%PDF-';
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

/* ----------------------------- Auth -------------------------------- */

app.post(
  '/api/auth/register',
  handle((req, res) => {
    const full_name = clean(req.body.full_name);
    const username = clean(req.body.username);
    const email = clean(req.body.email);
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!full_name || full_name.length > 120) throw new HttpError(400, 'Full name is required (max 120 characters).');
    if (!username || !/^[A-Za-z0-9_.]{3,40}$/.test(username))
      throw new HttpError(400, 'Username must be 3-40 characters: letters, numbers, "_" or ".".');
    if (!email || email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new HttpError(400, 'A valid email address is required.');
    if (password.length < 6 || password.length > 128) throw new HttpError(400, 'Password must be 6-128 characters.');

    const conflicts = sql.userConflict.all(email, username, email, username);
    if (conflicts.some((r) => r.email_taken)) throw new HttpError(409, 'An account with this email already exists.');
    if (conflicts.some((r) => r.username_taken)) throw new HttpError(409, 'This username is already taken.');

    const info = sql.insertUser.run(full_name, username, email.toLowerCase(), bcrypt.hashSync(password, 10));
    const user = sql.userById.get(info.lastInsertRowid);
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  })
);

app.post(
  '/api/auth/login',
  handle((req, res) => {
    const login = clean(req.body.email) || clean(req.body.username) || clean(req.body.identifier);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!login || !password) throw new HttpError(400, 'Email (or username) and password are required.');

    const user = sql.userByLogin.get(login, login);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      throw new HttpError(401, 'Invalid email or password.');
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  })
);

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/* ------------------------- Public catalog -------------------------- */

app.get('/api/stats', handle((req, res) => res.json(sql.stats.get())));

app.get('/api/categories', handle((req, res) => res.json({ categories: sql.categories.all() })));

app.get('/api/leaderboard', handle((req, res) => res.json({ leaders: sql.leaderboard.all() })));

app.get(
  '/api/books',
  handle((req, res) => {
    const where = [];
    const params = [];

    const rawCategory = clean(req.query.category_id);
    if (rawCategory) {
      where.push('category_id = ?');
      params.push(requireId(rawCategory, 'category_id'));
    }

    const search = clean(req.query.search);
    if (search) {
      const term = `%${escapeLike(search.slice(0, 200))}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR isbn LIKE ? ESCAPE '\\')");
      params.push(term, term, term);
    }

    const sortKey = clean(req.query.sort) || 'newest';
    if (!BOOK_SORTS[sortKey]) throw new HttpError(400, 'sort must be one of: newest, popular, rating, title.');

    let limitClause = '';
    const rawLimit = clean(req.query.limit);
    if (rawLimit) {
      const limit = parseId(rawLimit);
      if (!limit || limit > 100) throw new HttpError(400, 'limit must be an integer between 1 and 100.');
      limitClause = ' LIMIT ?';
      params.push(limit);
    }

    const query =
      'SELECT * FROM vw_BookCatalog' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ` ORDER BY ${BOOK_SORTS[sortKey]}` +
      limitClause;

    const books = db.prepare(query).all(...params);
    res.json({ count: books.length, books });
  })
);

app.get(
  '/api/books/:id',
  optionalAuth,
  handle((req, res) => {
    const id = requireId(req.params.id, 'book id');
    const book = sql.catalogById.get(id);
    if (!book) throw new HttpError(404, 'Book not found.');
    const related = book.category_id ? sql.related.all(book.category_id, id) : [];
    const uid = req.user ? req.user.user_id : null;
    const is_bookmarked = uid ? Boolean(sql.findBookmark.get(uid, id)) : false;

    let recommendations = sql.recommendations.all(id).map((r) => ({ ...r, source: 'co-download' }));
    if (recommendations.length < 2) {
      const seen = new Set(recommendations.map((r) => r.book_id));
      const fill = related.filter((r) => !seen.has(r.book_id)).map((r) => ({ ...r, co_downloads: 0, source: 'category' }));
      recommendations = recommendations.concat(fill).slice(0, 4);
    }

    res.json({
      book: { ...book, is_bookmarked, pdf_pages: pdfPagesFor(book.file_path) },
      related,
      recommendations,
      reviews: sql.bookReviews.all(id),
      my_review: uid ? sql.myReview.get(uid, id) || null : null,
      has_downloaded: uid ? Boolean(sql.hasDownloaded.get(uid, id)) : false,
      progress: uid ? sql.myProgress.get(uid, id) || null : null,
      notes: sql.bookNotes.all(id, uid || -1),
    });
  })
);

app.post(
  '/api/books/:id/reviews',
  requireAuth,
  handle((req, res) => {
    const id = requireId(req.params.id, 'book id');
    if (!sql.bookById.get(id)) throw new HttpError(404, 'Book not found.');
    if (!sql.hasDownloaded.get(req.user.user_id, id)) {
      throw new HttpError(403, 'Download this book first to leave a verified review');
    }
    const rating = requireInt(req.body.rating, 'rating', 1, 5);
    const comment = clean(req.body.comment);
    if (comment && comment.length > 1000) throw new HttpError(400, 'Reviews can be at most 1000 characters.');

    sql.upsertReview.run(req.user.user_id, id, rating, comment);
    res.status(201).json({
      review: sql.myReview.get(req.user.user_id, id),
      book: { book_id: id, ...sql.bookRating.get(id) },
    });
  })
);

app.put(
  '/api/books/:id/progress',
  requireAuth,
  handle((req, res) => {
    const id = requireId(req.params.id, 'book id');
    if (!sql.bookById.get(id)) throw new HttpError(404, 'Book not found.');
    const total = requireInt(req.body.total_pages, 'total_pages', 1, 100000);
    const current = requireInt(req.body.current_page, 'current_page', 1, 100000);
    if (current > total) throw new HttpError(400, 'Current page cannot be greater than total pages.');

    sql.upsertProgress.run(req.user.user_id, id, current, total);
    res.json({ progress: { book_id: id, ...sql.myProgress.get(req.user.user_id, id) } });
  })
);

/* ------------------- Page-Anchored Reading Notes ------------------- */

app.get(
  '/api/books/:id/notes',
  optionalAuth,
  handle((req, res) => {
    const id = requireId(req.params.id, 'book id');
    if (!sql.bookById.get(id)) throw new HttpError(404, 'Book not found.');
    const uid = req.user ? req.user.user_id : -1;
    res.json({ notes: sql.bookNotes.all(id, uid) });
  })
);

app.post(
  '/api/books/:id/notes',
  requireAuth,
  handle((req, res) => {
    const id = requireId(req.params.id, 'book id');
    if (!sql.bookById.get(id)) throw new HttpError(404, 'Book not found.');
    const page = requireInt(req.body.page_number, 'page_number', 1, 100000);
    const noteText = clean(req.body.note_text);
    if (!noteText || noteText.length > 600) throw new HttpError(400, 'Note text is required (max 600 characters).');
    const isPublic = req.body.is_public ? 1 : 0;

    sql.insertNote.run(req.user.user_id, id, page, noteText, isPublic);
    res.status(201).json({ notes: sql.bookNotes.all(id, req.user.user_id) });
  })
);

app.delete(
  '/api/books/:id/notes/:noteId',
  requireAuth,
  handle((req, res) => {
    const id = requireId(req.params.id, 'book id');
    const noteId = requireId(req.params.noteId, 'note id');
    const note = sql.noteById.get(noteId);
    if (!note || note.book_id !== id) throw new HttpError(404, 'Note not found.');
    if (note.user_id !== req.user.user_id && req.user.role !== 'admin') {
      throw new HttpError(403, 'You can only delete your own notes.');
    }
    sql.deleteNote.run(noteId, note.user_id);
    res.json({ notes: sql.bookNotes.all(id, req.user.user_id) });
  })
);

/* ------------------- Community Book Request Board ------------------ */

app.get(
  '/api/requests',
  optionalAuth,
  handle((req, res) => {
    const uid = req.user ? req.user.user_id : null;
    res.json({ requests: sql.listRequests.all(uid, uid) });
  })
);

const createRequestWithVote = db.transaction((userId, title, author, isbn, reason) => {
  const info = sql.insertRequest.run(userId, title, author, isbn, reason);
  const reqId = Number(info.lastInsertRowid);
  sql.insertVote.run(userId, reqId);
  return reqId;
});

app.post(
  '/api/requests',
  requireAuth,
  handle((req, res) => {
    const title = clean(req.body.title);
    const author = clean(req.body.author);
    const reason = clean(req.body.reason);
    if (!title || title.length > 255) throw new HttpError(400, 'Book title is required (max 255 characters).');
    if (!author || author.length > 255) throw new HttpError(400, 'Author name is required (max 255 characters).');
    if (reason && reason.length > 500) throw new HttpError(400, 'Note/reason must be at most 500 characters.');

    let isbn = clean(req.body.isbn);
    if (isbn) {
      isbn = isbn.replace(/[\s-]/g, '').toUpperCase();
      if (!/^(\d{9}[\dX]|\d{13})$/.test(isbn)) throw new HttpError(400, 'ISBN must be 10 or 13 digits.');
    }

    createRequestWithVote(req.user.user_id, title, author, isbn, reason);
    res.status(201).json({ requests: sql.listRequests.all(req.user.user_id, req.user.user_id) });
  })
);

const toggleRequestVote = db.transaction((userId, requestId) => {
  const existing = sql.findVote.get(userId, requestId);
  if (existing) {
    sql.deleteVote.run(userId, requestId);
    return false;
  }
  sql.insertVote.run(userId, requestId);
  return true;
});

app.post(
  '/api/requests/:id/vote',
  requireAuth,
  handle((req, res) => {
    const id = requireId(req.params.id, 'request id');
    if (!sql.requestById.get(id)) throw new HttpError(404, 'Book request not found.');
    const voted = toggleRequestVote(req.user.user_id, id);
    res.json({ voted, requests: sql.listRequests.all(req.user.user_id, req.user.user_id) });
  })
);

app.patch(
  '/api/admin/requests/:id/fulfill',
  requireAdmin,
  handle((req, res) => {
    const id = requireId(req.params.id, 'request id');
    if (!sql.requestById.get(id)) throw new HttpError(404, 'Book request not found.');
    const bookId = req.body.book_id ? requireId(req.body.book_id, 'book_id') : null;
    sql.fulfillRequest.run(bookId, id);
    res.json({ requests: sql.listRequests.all(req.user.user_id, req.user.user_id) });
  })
);

/* ------------------------ Reader actions --------------------------- */

app.post(
  '/api/books/:id/download',
  requireAuth,
  handle((req, res) => {
    const id = requireId(req.params.id, 'book id');
    const book = sql.bookById.get(id);
    if (!book) throw new HttpError(404, 'Book not found.');
    const disk = uploadsDiskPath(book.file_path);
    if (!disk || !fs.existsSync(disk)) throw new HttpError(410, 'The file for this book is no longer available.');

    sql.insertDownload.run(req.user.user_id, id);
    const { total_downloads } = sql.downloadCount.get(id);
    res.status(201).json({
      downloadUrl: book.file_path,
      filename: `${slugify(book.title)}.pdf`,
      total_downloads,
    });
  })
);

const toggleBookmark = db.transaction((userId, bookId) => {
  const existing = sql.findBookmark.get(userId, bookId);
  if (existing) {
    sql.deleteBookmark.run(existing.bookmark_id);
    return false;
  }
  sql.insertBookmark.run(userId, bookId);
  return true;
});

app.post(
  '/api/books/:id/bookmark',
  requireAuth,
  handle((req, res) => {
    const id = requireId(req.params.id, 'book id');
    if (!sql.bookById.get(id)) throw new HttpError(404, 'Book not found.');
    res.json({ bookmarked: toggleBookmark(req.user.user_id, id) });
  })
);

app.get(
  '/api/user/dashboard',
  requireAuth,
  handle((req, res) => {
    const uid = req.user.user_id;
    res.json({
      user: publicUser(req.user),
      summary: { ...sql.userSummary.get(uid, uid, uid), in_progress: sql.userProgress.all(uid).length },
      downloads: sql.userDownloads.all(uid),
      bookmarks: sql.userBookmarks.all(uid),
      reading_progress: sql.userProgress.all(uid),
    });
  })
);

/* ----------------------------- Admin ------------------------------- */

app.get('/api/admin/audit-logs', requireAdmin, (req, res, next) => {
  try {
    res.json({ logs: sql.auditLogs.all() });
  } catch (err) {
    next(err);
  }
});

function runUpload(req, res, next) {
  upload(req, res, (err) => {
    if (err) {
      cleanupUploads(req);
      return next(err);
    }
    next();
  });
}

app.post('/api/admin/books', requireAdmin, runUpload, (req, res, next) => {
  const { cover, bookFile } = uploadedFiles(req);
  let generatedCover = null;
  try {
    const title = clean(req.body.title);
    const author = clean(req.body.author);
    const description = clean(req.body.description);
    if (!title || title.length > 255) throw new HttpError(400, 'Title is required (max 255 characters).');
    if (!author || author.length > 255) throw new HttpError(400, 'Author is required (max 255 characters).');
    if (!bookFile) throw new HttpError(400, 'A PDF file is required in the "bookFile" field.');
    if (!isRealPdf(bookFile.path)) throw new HttpError(400, 'Uploaded book file is not a valid PDF.');

    let isbn = clean(req.body.isbn);
    if (isbn) {
      isbn = isbn.replace(/[\s-]/g, '').toUpperCase();
      if (!/^(\d{9}[\dX]|\d{13})$/.test(isbn)) throw new HttpError(400, 'ISBN must be 10 or 13 digits.');
    }

    let published_year = null;
    if (clean(req.body.published_year)) {
      published_year = Number(req.body.published_year);
      if (!Number.isInteger(published_year) || published_year < 0 || published_year > 2100)
        throw new HttpError(400, 'published_year must be an integer between 0 and 2100.');
    }

    let pages = null;
    if (clean(req.body.pages)) {
      pages = parseId(req.body.pages);
      if (!pages) throw new HttpError(400, 'pages must be a positive integer.');
    }

    let category = null;
    if (clean(req.body.category_id)) {
      category = sql.categoryById.get(requireId(req.body.category_id, 'category_id'));
      if (!category) throw new HttpError(400, 'category_id does not reference an existing category.');
    }

    let coverPath;
    if (cover) {
      coverPath = `/uploads/covers/${cover.filename}`;
    } else {
      const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.svg`;
      generatedCover = path.join(COVERS_DIR, filename);
      fs.writeFileSync(
        generatedCover,
        generateCoverSvg({ title, author, categoryName: category && category.category_name, categorySlug: category && category.slug }),
        'utf8'
      );
      coverPath = `/uploads/covers/${filename}`;
    }

    const info = sql.insertBook.run(
      title,
      author,
      isbn,
      published_year,
      pages,
      description,
      coverPath,
      `/uploads/books/${bookFile.filename}`,
      category ? category.category_id : null
    );
    res.status(201).json({ book: sql.catalogById.get(info.lastInsertRowid) });
  } catch (err) {
    cleanupUploads(req);
    safeUnlink(generatedCover);
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return next(new HttpError(409, 'A book with this ISBN already exists.'));
    next(err);
  }
});

app.delete(
  '/api/admin/books/:id',
  requireAdmin,
  handle((req, res) => {
    const id = requireId(req.params.id, 'book id');
    const book = sql.bookById.get(id);
    if (!book) throw new HttpError(404, 'Book not found.');

    sql.deleteBook.run(id);
    safeUnlink(uploadsDiskPath(book.cover_path));
    safeUnlink(uploadsDiskPath(book.file_path));
    res.json({ deleted: true, book_id: id });
  })
);

/* --------------------------- Fallbacks ----------------------------- */

app.use('/api', (req, res) => {
  res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl}.` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 50 MB upload limit.' : err.message;
    return res.status(400).json({ error: message });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON.' });
  if (typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    return res.status(409).json({ error: 'That change conflicts with an existing record. Please check your details.' });
  }
  console.error('[booknest] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

/* ----------------------------- Start ------------------------------- */

let server = null;

initDatabase(db)
  .then(({ seeded, restored }) => {
    server = app.listen(PORT, () => {
      console.log(`[booknest] Database ready${seeded ? ' (seeded with sample data)' : ''}${restored ? `, restored ${restored} asset(s)` : ''}.`);
      console.log(`[booknest] Server running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[booknest] Failed to initialize the database:', err);
    process.exit(1);
  });

function shutdown() {
  const finish = () => {
    db.close();
    process.exit(0);
  };
  if (server) server.close(finish);
  else finish();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;