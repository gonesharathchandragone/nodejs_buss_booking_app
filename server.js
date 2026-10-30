const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const IS_PROD = process.env.NODE_ENV === "production";
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// Fail fast: never run in production with the default secrets.
if (IS_PROD && (JWT_SECRET === "change-this-secret" || ADMIN_PASSWORD === "admin123")) {
  console.error("Set JWT_SECRET and ADMIN_PASSWORD environment variables in production.");
  process.exit(1);
}

// Behind nginx / a load balancer, trust the proxy so client IPs and HTTPS are detected correctly.
if (process.env.TRUST_PROXY) app.set("trust proxy", 1);
app.disable("x-powered-by");

/* ------------------------------------------------------------------ */
/* In-memory "database" (swap for MongoDB / PostgreSQL in production)  */
/* ------------------------------------------------------------------ */
const db = {
  users: [],
  buses: [],
  bookings: [],
};

const id = () => crypto.randomUUID();

// Seed an admin and some buses
db.users.push({
  id: id(),
  name: "Admin",
  email: "admin@example.com",
  password: bcrypt.hashSync(ADMIN_PASSWORD, 10),
  role: "admin",
});

db.buses.push(
  {
    id: id(),
    name: "Express Travels",
    from: "Hyderabad",
    to: "Bangalore",
    departure: "21:00",
    arrival: "05:00",
    price: 850,
    totalSeats: 40,
  },
  {
    id: id(),
    name: "Sunrise Coaches",
    from: "Hyderabad",
    to: "Chennai",
    departure: "20:30",
    arrival: "06:30",
    price: 950,
    totalSeats: 36,
  }
);

/* ------------------------------ Helpers ---------------------------- */
const isValidDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

function bookedSeats(busId, date) {
  return db.bookings
    .filter((b) => b.busId === busId && b.date === date && b.status === "CONFIRMED")
    .flatMap((b) => b.seats);
}

/* ------------------------------ Root ------------------------------- */
app.get("/api", (req, res) => {
  res.json({
    message: "Bus Booking API is running",
    endpoints: [
      "POST   /api/auth/register",
      "POST   /api/auth/login",
      "GET    /api/buses?from=&to=&date=YYYY-MM-DD",
      "GET    /api/buses/:id/seats?date=YYYY-MM-DD",
      "POST   /api/buses            (admin)",
      "POST   /api/bookings         (login required)",
      "GET    /api/bookings         (login required)",
      "DELETE /api/bookings/:id     (login required)",
    ],
  });
});

/* ------------------------------ Auth ------------------------------- */
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

const signToken = (u) =>
  jwt.sign({ id: u.id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: "1d" });

app.post("/api/auth/register", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6)
    return res.status(400).json({ error: "name, email and password (min 6 chars) are required" });
  if (db.users.some((u) => u.email === email.toLowerCase()))
    return res.status(409).json({ error: "Email already registered" });

  const user = {
    id: id(),
    name,
    email: email.toLowerCase(),
    password: bcrypt.hashSync(password, 10),
    role: "user",
  };
  db.users.push(user);
  res.status(201).json({ token: signToken(user), user: { id: user.id, name, email: user.email } });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.users.find((u) => u.email === (email || "").toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password))
    return res.status(401).json({ error: "Invalid credentials" });
  res.json({ token: signToken(user), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

/* ------------------------------ Buses ------------------------------ */
// Search: GET /api/buses?from=Hyderabad&to=Bangalore&date=2026-11-05
app.get("/api/buses", (req, res) => {
  const { from, to, date } = req.query;
  if (date && !isValidDate(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });

  const results = db.buses
    .filter((b) => (!from || b.from.toLowerCase() === from.toLowerCase()))
    .filter((b) => (!to || b.to.toLowerCase() === to.toLowerCase()))
    .map((b) => ({
      ...b,
      availableSeats: date ? b.totalSeats - bookedSeats(b.id, date).length : undefined,
    }));
  res.json(results);
});

// Seat map: GET /api/buses/:id/seats?date=2026-11-05
app.get("/api/buses/:id/seats", (req, res) => {
  const bus = db.buses.find((b) => b.id === req.params.id);
  if (!bus) return res.status(404).json({ error: "Bus not found" });
  const { date } = req.query;
  if (!isValidDate(date)) return res.status(400).json({ error: "date (YYYY-MM-DD) is required" });

  const booked = new Set(bookedSeats(bus.id, date));
  const seats = Array.from({ length: bus.totalSeats }, (_, i) => ({
    seat: i + 1,
    available: !booked.has(i + 1),
  }));
  res.json({ busId: bus.id, date, seats });
});

// Admin: add a bus
app.post("/api/buses", auth, adminOnly, (req, res) => {
  const { name, from, to, departure, arrival, price, totalSeats } = req.body;
  if (!name || !from || !to || !departure || !arrival || !(price > 0) || !(totalSeats > 0))
    return res.status(400).json({ error: "Missing or invalid bus fields" });
  const bus = { id: id(), name, from, to, departure, arrival, price, totalSeats };
  db.buses.push(bus);
  res.status(201).json(bus);
});

/* ---------------------------- Bookings ----------------------------- */
// Book seats: POST /api/bookings
// { "busId": "...", "date": "2026-11-05", "seats": [3,4], "passengers": [{"name":"A","age":30},{"name":"B","age":28}] }
app.post("/api/bookings", auth, (req, res) => {
  const { busId, date, seats, passengers } = req.body;

  const bus = db.buses.find((b) => b.id === busId);
  if (!bus) return res.status(404).json({ error: "Bus not found" });
  if (!isValidDate(date)) return res.status(400).json({ error: "date (YYYY-MM-DD) is required" });
  if (new Date(date) < new Date(new Date().toISOString().slice(0, 10)))
    return res.status(400).json({ error: "Cannot book for a past date" });

  if (!Array.isArray(seats) || seats.length === 0 || seats.length > 6)
    return res.status(400).json({ error: "Select 1 to 6 seats" });
  if (new Set(seats).size !== seats.length)
    return res.status(400).json({ error: "Duplicate seats in request" });
  if (seats.some((s) => !Number.isInteger(s) || s < 1 || s > bus.totalSeats))
    return res.status(400).json({ error: `Seat numbers must be between 1 and ${bus.totalSeats}` });
  if (!Array.isArray(passengers) || passengers.length !== seats.length)
    return res.status(400).json({ error: "Provide one passenger per seat" });

  // Check + write happens synchronously, so two requests cannot double-book
  // in this in-memory version. With a real DB, use a transaction or a
  // unique index on (busId, date, seat).
  const taken = new Set(bookedSeats(bus.id, date));
  const conflict = seats.filter((s) => taken.has(s));
  if (conflict.length)
    return res.status(409).json({ error: "Some seats are already booked", seats: conflict });

  const booking = {
    id: id(),
    userId: req.user.id,
    busId: bus.id,
    date,
    seats,
    passengers,
    amount: bus.price * seats.length,
    status: "CONFIRMED",
    createdAt: new Date().toISOString(),
  };
  db.bookings.push(booking);
  res.status(201).json(booking);
});

// My bookings
app.get("/api/bookings", auth, (req, res) => {
  const mine = db.bookings
    .filter((b) => b.userId === req.user.id)
    .map((b) => ({ ...b, bus: db.buses.find((x) => x.id === b.busId) }));
  res.json(mine);
});

// Cancel booking
app.delete("/api/bookings/:id", auth, (req, res) => {
  const booking = db.bookings.find((b) => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: "Booking not found" });
  if (booking.userId !== req.user.id && req.user.role !== "admin")
    return res.status(403).json({ error: "Not your booking" });
  if (booking.status === "CANCELLED")
    return res.status(400).json({ error: "Already cancelled" });

  booking.status = "CANCELLED";
  booking.cancelledAt = new Date().toISOString();
  res.json({ message: "Booking cancelled", booking });
});

/* ------------------------------ Errors ----------------------------- */
app.use((req, res) => res.status(404).json({ error: "Route not found" }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;

// Equivalent of Python's `if __name__ == "__main__":` - only start the server when run directly
// (`node server.js`), not when this file is imported (for example by tests).
if (require.main === module) {
  // Local development: `npm run dev`. In production, run `NODE_ENV=production node server.js`
  // under a process manager such as pm2 or systemd.
  const server = app.listen(PORT, HOST, () =>
    console.log(`Bus booking app running on http://${HOST}:${PORT} (${IS_PROD ? "production" : "development"})`)
  );

  // Graceful shutdown so in-flight requests finish when the process manager restarts the app.
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
