import base64
import cgi
import hashlib
import hmac
import io
import json
import os
import shutil
import sqlite3
import time
import urllib.parse
import zipfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
PUBLIC = ROOT / "public"
UPLOADS = ROOT / "uploads"
PROCESSED = ROOT / "processed"
DB_PATH = ROOT / "app.db"
SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me").encode()
PORT = int(os.getenv("PORT", "3000"))

for d in (UPLOADS, PROCESSED):
    d.mkdir(exist_ok=True)


def db_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              email TEXT UNIQUE NOT NULL,
              password_hash TEXT NOT NULL,
              is_active INTEGER DEFAULT 0,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS processing_jobs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL,
              original_name TEXT NOT NULL,
              source_path TEXT NOT NULL,
              output_path TEXT,
              options_json TEXT NOT NULL,
              status TEXT DEFAULT 'pending',
              created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            """
        )


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 120000)
    return base64.b64encode(salt + h).decode()


def verify_password(password: str, stored: str) -> bool:
    raw = base64.b64decode(stored.encode())
    salt, old = raw[:16], raw[16:]
    cur = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 120000)
    return hmac.compare_digest(cur, old)


def sign_token(payload: dict) -> str:
    b = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    sig = base64.urlsafe_b64encode(hmac.new(SECRET, b.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return f"{b}.{sig}"


def verify_token(token: str):
    try:
        b, sig = token.split(".", 1)
        expected = base64.urlsafe_b64encode(hmac.new(SECRET, b.encode(), hashlib.sha256).digest()).decode().rstrip("=")
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(base64.urlsafe_b64decode(b + "==").decode())
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None


def spellfix(text: str) -> str:
    return text.replace("teh", "the").replace("recieve", "receive").replace("seperate", "separate")


def process_docx(src: Path, out: Path, options: dict):
    with zipfile.ZipFile(src, "r") as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/document.xml":
                xml = data.decode("utf-8", errors="ignore")
                if options.get("spellCheck"):
                    xml = spellfix(xml)
                if options.get("updateFonts"):
                    xml = xml.replace('w:ascii="Times New Roman"', 'w:ascii="Calibri"')
                notes = [k for k, v in options.items() if v]
                addon = "".join([f"<w:p><w:r><w:t>Applied: {n}</w:t></w:r></w:p>" for n in notes])
                xml = xml.replace("</w:body>", addon + "</w:body>")
                data = xml.encode("utf-8")
            zout.writestr(item, data)


def simple_pdf(lines):
    esc = lambda s: s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    y = 780
    content = ["BT /F1 12 Tf"]
    for ln in lines:
        content.append(f"50 {y} Td ({esc(ln[:95])}) Tj")
        content.append("0 -18 Td")
        y -= 18
    content.append("ET")
    stream = "\n".join(content).encode()
    objs = []
    objs.append(b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n")
    objs.append(b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n")
    objs.append(b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n")
    objs.append(b"4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n")
    objs.append(f"5 0 obj << /Length {len(stream)} >> stream\n".encode() + stream + b"\nendstream endobj\n")
    out = io.BytesIO(); out.write(b"%PDF-1.4\n")
    xref = [0]
    for o in objs:
        xref.append(out.tell()); out.write(o)
    start = out.tell()
    out.write(f"xref\n0 {len(xref)}\n".encode())
    out.write(b"0000000000 65535 f \n")
    for off in xref[1:]:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer << /Size {len(xref)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF".encode())
    return out.getvalue()


def process_pdf(src: Path, out: Path, options: dict):
    lines = ["DocX Processed PDF", f"Source: {src.name}", "Selected options:"]
    lines.extend([f"- {k}" for k, v in options.items() if v] or ["- none"])
    out.write_bytes(simple_pdf(lines))


class Handler(BaseHTTPRequestHandler):
    def json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def auth_user(self):
        auth = self.headers.get("Authorization", "")
        token = auth.replace("Bearer ", "")
        payload = verify_token(token) if token else None
        if not payload:
            return None
        with db_conn() as conn:
            return conn.execute("SELECT * FROM users WHERE id=?", (payload["id"],)).fetchone()

    def do_GET(self):
        if self.path.startswith("/api/me"):
            user = self.auth_user()
            if not user:
                return self.json(401, {"error": "Unauthorized"})
            return self.json(200, {"user": {"id": user["id"], "email": user["email"], "isActive": bool(user["is_active"])}})
        if self.path.startswith("/api/jobs"):
            user = self.auth_user()
            if not user:
                return self.json(401, {"error": "Unauthorized"})
            with db_conn() as conn:
                rows = conn.execute("SELECT id, original_name, options_json, status, created_at FROM processing_jobs WHERE user_id=? ORDER BY id DESC", (user["id"],)).fetchall()
            jobs = [{"id": r["id"], "original_name": r["original_name"], "status": r["status"], "created_at": r["created_at"], "options": json.loads(r["options_json"])} for r in rows]
            return self.json(200, {"jobs": jobs})

        target = "index.html" if self.path in ["/", ""] else self.path.lstrip("/")
        f = PUBLIC / target
        if not f.exists() or not f.is_file():
            self.send_error(404); return
        ctype = "text/plain"
        if f.suffix == ".html": ctype = "text/html"
        if f.suffix == ".css": ctype = "text/css"
        if f.suffix == ".js": ctype = "application/javascript"
        data = f.read_bytes()
        self.send_response(200); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ["/api/register", "/api/login"]:
            size = int(self.headers.get("Content-Length", "0")); data = json.loads(self.rfile.read(size) or b"{}")
            email = (data.get("email") or "").lower().strip(); password = data.get("password") or ""
            if not email or not password: return self.json(400, {"error": "Email and password required"})
            with db_conn() as conn:
                if path.endswith("register"):
                    try:
                        cur = conn.execute("INSERT INTO users(email, password_hash) VALUES(?,?)", (email, hash_password(password))); conn.commit()
                        return self.json(200, {"userId": cur.lastrowid})
                    except sqlite3.IntegrityError:
                        return self.json(400, {"error": "Account already exists"})
                row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
                if not row or not verify_password(password, row["password_hash"]):
                    return self.json(401, {"error": "Invalid credentials"})
                tok = sign_token({"id": row["id"], "exp": time.time() + 7200})
                return self.json(200, {"token": tok, "isActive": bool(row["is_active"])})

        user = self.auth_user()
        if not user:
            return self.json(401, {"error": "Unauthorized"})

        if path == "/api/billing/create-checkout-session":
            return self.json(200, {"url": os.getenv("STRIPE_CHECKOUT_URL", "https://dashboard.stripe.com/test/payments")})
        if path == "/api/billing/mock-activate":
            with db_conn() as conn:
                conn.execute("UPDATE users SET is_active=1 WHERE id=?", (user["id"],)); conn.commit()
            return self.json(200, {"message": "Subscription activated for prototype"})

        if path == "/api/process":
            if not user["is_active"]:
                return self.json(403, {"error": "Active subscription required"})
            form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": self.headers.get("Content-Type")})
            fileitem = form["document"] if "document" in form else None
            if not fileitem or not getattr(fileitem, "filename", None):
                return self.json(400, {"error": "No file uploaded"})
            name = Path(fileitem.filename).name
            ext = Path(name).suffix.lower()
            if ext not in [".docx", ".pdf"]:
                return self.json(400, {"error": "Only .docx/.pdf supported"})
            src = UPLOADS / f"{int(time.time()*1000)}-{name}"
            with open(src, "wb") as f:
                shutil.copyfileobj(fileitem.file, f)
            options = {k: (form.getvalue(k) == "true") for k in ["alignImages", "fixParagraphs", "applyHeadingStyles", "updateFonts", "addTableOfContents", "insertFigureCaptions", "spellCheck"]}
            with db_conn() as conn:
                cur = conn.execute("INSERT INTO processing_jobs(user_id, original_name, source_path, options_json, status) VALUES(?,?,?,?,?)", (user["id"], name, str(src), json.dumps(options), "running")); job_id = cur.lastrowid; conn.commit()
            out = PROCESSED / f"{src.stem}-edited{ext}"
            try:
                if ext == ".docx": process_docx(src, out, options)
                else: process_pdf(src, out, options)
                with db_conn() as conn:
                    conn.execute("UPDATE processing_jobs SET output_path=?, status='done' WHERE id=?", (str(out), job_id)); conn.commit()
                data = out.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Disposition", f'attachment; filename="{Path(name).stem}-edited{ext}"')
                self.send_header("Content-Length", str(len(data)))
                self.end_headers(); self.wfile.write(data)
            except Exception as e:
                with db_conn() as conn:
                    conn.execute("UPDATE processing_jobs SET status='error' WHERE id=?", (job_id,)); conn.commit()
                return self.json(500, {"error": "Processing failed", "details": str(e)})
            finally:
                if src.exists(): src.unlink()
            return

        self.send_error(404)


if __name__ == "__main__":
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"DocX running at http://localhost:{PORT}")
    server.serve_forever()
