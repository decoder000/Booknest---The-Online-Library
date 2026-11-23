-- =====================================================================
-- Booknest - Relational Schema (Third Normal Form)
-- =====================================================================

CREATE TABLE IF NOT EXISTS Users (
    user_id        INTEGER      PRIMARY KEY AUTOINCREMENT,
    full_name      VARCHAR(120) NOT NULL,
    username       VARCHAR(40)  NOT NULL UNIQUE,
    email          VARCHAR(255) NOT NULL UNIQUE,
    password_hash  VARCHAR(255) NOT NULL,
    role           VARCHAR(10)  NOT NULL DEFAULT 'user'
                   CHECK (role IN ('user', 'admin')),
    created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (LENGTH(TRIM(full_name)) > 0),
    CHECK (LENGTH(username) >= 3),
    CHECK (email LIKE '%_@_%._%')
);

CREATE TABLE IF NOT EXISTS Categories (
    category_id    INTEGER      PRIMARY KEY AUTOINCREMENT,
    category_name  VARCHAR(80)  NOT NULL UNIQUE,
    slug           VARCHAR(80)  NOT NULL UNIQUE,
    description    TEXT,
    CHECK (LENGTH(TRIM(category_name)) > 0),
    CHECK (LENGTH(TRIM(slug)) > 0)
);

CREATE TABLE IF NOT EXISTS Books (
    book_id         INTEGER      PRIMARY KEY AUTOINCREMENT,
    title           VARCHAR(255) NOT NULL,
    author          VARCHAR(255) NOT NULL,
    isbn            VARCHAR(20)  UNIQUE,
    published_year  INTEGER      CHECK (published_year IS NULL OR published_year BETWEEN 0 AND 2100),
    pages           INTEGER      CHECK (pages IS NULL OR pages > 0),
    description     TEXT,
    cover_path      VARCHAR(500),
    file_path       VARCHAR(500) NOT NULL,
    category_id     INTEGER,
    uploaded_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    avg_rating      REAL         DEFAULT 0,
    review_count    INTEGER      DEFAULT 0,
    CHECK (LENGTH(TRIM(title)) > 0),
    CHECK (LENGTH(TRIM(author)) > 0),
    FOREIGN KEY (category_id) REFERENCES Categories (category_id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS Downloads (
    download_id    INTEGER   PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER   NOT NULL,
    book_id        INTEGER   NOT NULL,
    downloaded_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES Users (user_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    FOREIGN KEY (book_id) REFERENCES Books (book_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS Bookmarks (
    bookmark_id    INTEGER   PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER   NOT NULL,
    book_id        INTEGER   NOT NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, book_id),
    FOREIGN KEY (user_id) REFERENCES Users (user_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    FOREIGN KEY (book_id) REFERENCES Books (book_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS Reviews (
    review_id      INTEGER   PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER   NOT NULL,
    book_id        INTEGER   NOT NULL,
    rating         INTEGER   NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment        TEXT,
    created_at     DATETIME  DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, book_id),
    FOREIGN KEY (user_id) REFERENCES Users (user_id)
        ON DELETE CASCADE,
    FOREIGN KEY (book_id) REFERENCES Books (book_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Reading_Progress (
    user_id        INTEGER   NOT NULL,
    book_id        INTEGER   NOT NULL,
    current_page   INTEGER   NOT NULL DEFAULT 1 CHECK (current_page >= 1),
    total_pages    INTEGER   NOT NULL DEFAULT 1 CHECK (total_pages >= 1),
    updated_at     DATETIME  DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, book_id),
    CHECK (current_page <= total_pages),
    FOREIGN KEY (user_id) REFERENCES Users (user_id)
        ON DELETE CASCADE,
    FOREIGN KEY (book_id) REFERENCES Books (book_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Reading_Notes (
    note_id        INTEGER   PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER   NOT NULL,
    book_id        INTEGER   NOT NULL,
    page_number    INTEGER   NOT NULL CHECK (page_number >= 1),
    note_text      TEXT      NOT NULL CHECK (LENGTH(TRIM(note_text)) > 0),
    is_public      INTEGER   NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
    created_at     DATETIME  DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES Users (user_id)
        ON DELETE CASCADE,
    FOREIGN KEY (book_id) REFERENCES Books (book_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Book_Requests (
    request_id        INTEGER      PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER      NOT NULL,
    title             VARCHAR(255) NOT NULL CHECK (LENGTH(TRIM(title)) > 0),
    author            VARCHAR(255) NOT NULL CHECK (LENGTH(TRIM(author)) > 0),
    isbn              VARCHAR(20),
    reason            TEXT,
    status            VARCHAR(15)  NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'fulfilled')),
    fulfilled_book_id INTEGER,
    created_at        DATETIME     DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES Users (user_id)
        ON DELETE CASCADE,
    FOREIGN KEY (fulfilled_book_id) REFERENCES Books (book_id)
        ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS Request_Votes (
    user_id        INTEGER   NOT NULL,
    request_id     INTEGER   NOT NULL,
    voted_at       DATETIME  DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, request_id),
    FOREIGN KEY (user_id) REFERENCES Users (user_id)
        ON DELETE CASCADE,
    FOREIGN KEY (request_id) REFERENCES Book_Requests (request_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Audit_Logs (
    log_id         INTEGER   PRIMARY KEY AUTOINCREMENT,
    action_type    TEXT      NOT NULL,
    entity_type    TEXT      NOT NULL,
    entity_id      INTEGER,
    details        TEXT,
    created_at     DATETIME  DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_books_category      ON Books (category_id);
CREATE INDEX IF NOT EXISTS idx_books_uploaded_at   ON Books (uploaded_at);
CREATE INDEX IF NOT EXISTS idx_books_title         ON Books (title);
CREATE INDEX IF NOT EXISTS idx_downloads_user      ON Downloads (user_id);
CREATE INDEX IF NOT EXISTS idx_downloads_book      ON Downloads (book_id);
CREATE INDEX IF NOT EXISTS idx_downloads_date      ON Downloads (downloaded_at);
CREATE INDEX IF NOT EXISTS idx_bookmarks_book      ON Bookmarks (book_id);
CREATE INDEX IF NOT EXISTS idx_reviews_book        ON Reviews (book_id);
CREATE INDEX IF NOT EXISTS idx_progress_book       ON Reading_Progress (book_id);
CREATE INDEX IF NOT EXISTS idx_notes_book_page     ON Reading_Notes (book_id, page_number);
CREATE INDEX IF NOT EXISTS idx_requests_status     ON Book_Requests (status);
CREATE INDEX IF NOT EXISTS idx_audit_created       ON Audit_Logs (created_at);

-- ---------------------------------------------------------------------
-- Triggers: rating aggregates on Books
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_reviews_after_insert;
CREATE TRIGGER trg_reviews_after_insert AFTER INSERT ON Reviews
BEGIN
    UPDATE Books
    SET avg_rating   = COALESCE((SELECT ROUND(AVG(r.rating), 2) FROM Reviews r WHERE r.book_id = Books.book_id), 0),
        review_count = (SELECT COUNT(*) FROM Reviews r WHERE r.book_id = Books.book_id)
    WHERE book_id = NEW.book_id;
END;

DROP TRIGGER IF EXISTS trg_reviews_after_update;
CREATE TRIGGER trg_reviews_after_update AFTER UPDATE ON Reviews
BEGIN
    UPDATE Books
    SET avg_rating   = COALESCE((SELECT ROUND(AVG(r.rating), 2) FROM Reviews r WHERE r.book_id = Books.book_id), 0),
        review_count = (SELECT COUNT(*) FROM Reviews r WHERE r.book_id = Books.book_id)
    WHERE book_id IN (OLD.book_id, NEW.book_id);
END;

DROP TRIGGER IF EXISTS trg_reviews_after_delete;
CREATE TRIGGER trg_reviews_after_delete AFTER DELETE ON Reviews
BEGIN
    UPDATE Books
    SET avg_rating   = COALESCE((SELECT ROUND(AVG(r.rating), 2) FROM Reviews r WHERE r.book_id = Books.book_id), 0),
        review_count = (SELECT COUNT(*) FROM Reviews r WHERE r.book_id = Books.book_id)
    WHERE book_id = OLD.book_id;
END;

-- ---------------------------------------------------------------------
-- Trigger: auto-fulfill matching open book requests when a book is published
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_books_fulfill_requests;
CREATE TRIGGER trg_books_fulfill_requests AFTER INSERT ON Books
BEGIN
    UPDATE Book_Requests
    SET status = 'fulfilled',
        fulfilled_book_id = NEW.book_id
    WHERE status = 'open'
      AND (
          (NEW.isbn IS NOT NULL AND isbn IS NOT NULL AND REPLACE(REPLACE(UPPER(isbn), '-', ''), ' ', '') = UPPER(NEW.isbn))
          OR LOWER(TRIM(title)) = LOWER(TRIM(NEW.title))
      );
END;

-- ---------------------------------------------------------------------
-- Triggers: audit trail
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_books_audit_insert;
CREATE TRIGGER trg_books_audit_insert AFTER INSERT ON Books
BEGIN
    INSERT INTO Audit_Logs (action_type, entity_type, entity_id, details)
    VALUES ('INSERT', 'Book', NEW.book_id, 'Added "' || NEW.title || '" by ' || NEW.author);
END;

DROP TRIGGER IF EXISTS trg_books_audit_delete;
CREATE TRIGGER trg_books_audit_delete AFTER DELETE ON Books
BEGIN
    INSERT INTO Audit_Logs (action_type, entity_type, entity_id, details)
    VALUES ('DELETE', 'Book', OLD.book_id, 'Deleted "' || OLD.title || '" by ' || OLD.author);
END;

DROP TRIGGER IF EXISTS trg_users_audit_insert;
CREATE TRIGGER trg_users_audit_insert AFTER INSERT ON Users
BEGIN
    INSERT INTO Audit_Logs (action_type, entity_type, entity_id, details)
    VALUES ('INSERT', 'User', NEW.user_id, 'New ' || NEW.role || ' account @' || NEW.username);
END;

DROP TRIGGER IF EXISTS trg_requests_audit_insert;
CREATE TRIGGER trg_requests_audit_insert AFTER INSERT ON Book_Requests
BEGIN
    INSERT INTO Audit_Logs (action_type, entity_type, entity_id, details)
    VALUES ('REQUEST', 'Book_Request', NEW.request_id, 'Requested "' || NEW.title || '" by ' || NEW.author);
END;

-- ---------------------------------------------------------------------
-- Views: vw_BookCatalog & vw_BookRequests
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS vw_BookCatalog;
CREATE VIEW vw_BookCatalog AS
SELECT
    b.book_id,
    b.title,
    b.author,
    b.isbn,
    b.published_year,
    b.pages,
    b.description,
    b.cover_path,
    b.file_path,
    b.category_id,
    c.category_name,
    c.slug              AS category_slug,
    b.uploaded_at,
    b.avg_rating,
    b.review_count,
    COUNT(d.download_id) AS total_downloads
FROM Books b
LEFT JOIN Categories c ON c.category_id = b.category_id
LEFT JOIN Downloads  d ON d.book_id     = b.book_id
GROUP BY
    b.book_id, b.title, b.author, b.isbn, b.published_year, b.pages,
    b.description, b.cover_path, b.file_path, b.category_id,
    c.category_name, c.slug, b.uploaded_at, b.avg_rating, b.review_count;

DROP VIEW IF EXISTS vw_BookRequests;
CREATE VIEW vw_BookRequests AS
SELECT
    br.request_id,
    br.user_id,
    u.full_name          AS requester_name,
    u.username           AS requester_username,
    br.title,
    br.author,
    br.isbn,
    br.reason,
    br.status,
    br.fulfilled_book_id,
    br.created_at,
    COUNT(rv.user_id)    AS vote_count
FROM Book_Requests br
INNER JOIN Users u        ON u.user_id = br.user_id
LEFT JOIN Request_Votes rv ON rv.request_id = br.request_id
GROUP BY
    br.request_id, br.user_id, u.full_name, u.username,
    br.title, br.author, br.isbn, br.reason, br.status,
    br.fulfilled_book_id, br.created_at;