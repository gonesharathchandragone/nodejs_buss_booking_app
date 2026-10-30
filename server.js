const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Helpers ----------
const readData = () => JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const writeData = (data) => fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

// Generate 8x10 seat layout (A1..H10). Rows A,B are premium.
const generateSeats = () => {
  const rows = ['A','B','C','D','E','F','G','H'];
  const seats = [];
  for (const row of rows) {
    for (let n = 1; n <= 10; n++) {
      seats.push({ id: `${row}${n}`, row, number: n, premium: row === 'A' || row === 'B' });
    }
  }
  return seats;
};

// ---------- API ----------

// Get all movies
app.get('/api/movies', (req, res) => {
  const data = readData();
  res.json(data.movies);
});

// Get seat layout + booked seats for a movie/showtime
app.get('/api/movies/:id/seats', (req, res) => {
  const { showtime } = req.query;
  if (!showtime) return res.status(400).json({ error: 'showtime required' });

  const data = readData();
  const movie = data.movies.find(m => m.id === Number(req.params.id));
  if (!movie) return res.status(404).json({ error: 'Movie not found' });

  const bookedSeats = data.bookings
    .filter(b => b.movieId === movie.id && b.showtime === showtime)
    .flatMap(b => b.seats);

  const seats = generateSeats().map(s => ({ ...s, booked: bookedSeats.includes(s.id) }));
  res.json({ seats, price: movie.price });
});

// Create a booking
app.post('/api/bookings', (req, res) => {
  const { movieId, showtime, seats, name, email } = req.body;

  if (!movieId || !showtime || !Array.isArray(seats) || !seats.length || !name || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const data = readData();
  const movie = data.movies.find(m => m.id === Number(movieId));
  if (!movie) return res.status(404).json({ error: 'Movie not found' });
  if (!movie.showtimes.includes(showtime)) {
    return res.status(400).json({ error: 'Invalid showtime' });
  }

  // Check seat availability
  const bookedSeats = data.bookings
    .filter(b => b.movieId === movie.id && b.showtime === showtime)
    .flatMap(b => b.seats);

  const conflict = seats.find(s => bookedSeats.includes(s));
  if (conflict) {
    return res.status(409).json({ error: `Seat ${conflict} is already booked` });
  }

  const booking = {
    id: 'CB-' + Date.now().toString(36).toUpperCase(),
    movieId: movie.id,
    movieTitle: movie.title,
    showtime,
    seats,
    name,
    email,
    total: seats.length * movie.price,
    createdAt: new Date().toISOString(),
  };

  data.bookings.push(booking);
  writeData(data);

  res.status(201).json(booking);
});

// Get booking by ID
app.get('/api/bookings/:id', (req, res) => {
  const data = readData();
  const booking = data.bookings.find(
    b => b.id.toLowerCase() === req.params.id.toLowerCase()
  );
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  res.json(booking);
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`🎬 Movie Booking App running at http://localhost:${PORT}`);
});
